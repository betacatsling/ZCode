import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventJournal } from "../src/agent-host/eventJournal.js";
import { CommandJournal } from "../src/agent-host/commandJournal.js";
import { journalPath } from "../src/agent-host/journalStorage.js";

const identity = { targetId: "local-a", workspaceIdentity: "workspace-a", harnessId: "mock", hostSessionId: "host-a", runtimeEpoch: "epoch-a" };

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "zcode-agent-host-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("event journal de-duplicates source events, detects gaps and replays after restart", async () => fixture(async (root) => {
  const source = { kind: "text.delta", hostSessionId: "host-a", runtimeEpoch: "epoch-a", sequence: 1, eventId: "native-1", at: 1, turnId: "turn", messageId: "message", text: "hi" } as const;
  let journal = await EventJournal.open(root, identity);
  assert.equal((await journal.append(source)).sequence, 1);
  assert.equal((await journal.append(source)).sequence, 1);
  await assert.rejects(journal.append({ ...source, text: "different" }), /collision/);
  assert.equal(journal.since(0).length, 1);
  await assert.rejects(journal.append({ ...source, sequence: 3, eventId: "native-3" }), /gap/);
  await journal.close();
  journal = await EventJournal.open(root, identity);
  assert.equal(journal.since(0)[0]?.sourceEventId, "native-1");
  await journal.append({ ...source, sequence: 2, eventId: "native-2", text: "!" });
  assert.deepEqual(journal.since(1).map((event) => event.sequence), [2]);
  await journal.close();
}));

test("Host journal refuses semantically invalid usage before durable append and keeps history readable", async () =>
  fixture(async (root) => {
    let journal = await EventJournal.open(root, identity);
    const usage = (
      sequence: number,
      eventId: string,
      fields: { inputTokens?: number; outputTokens?: number },
    ) => ({
      kind: "usage.accounted" as const,
      hostSessionId: identity.hostSessionId,
      runtimeEpoch: identity.runtimeEpoch,
      sequence,
      eventId,
      at: sequence,
      turnId: "turn",
      sourceId: "call",
      accounting: "absolute" as const,
      ...fields,
    });
    await journal.append(usage(1, "first", { inputTokens: 5 }));
    await assert.rejects(
      journal.append(usage(2, "omitted", { outputTokens: 3 })),
      /omitted prior metric/,
    );
    await assert.rejects(journal.append(usage(2, "decreased", { inputTokens: 4 })), /regressed/);
    assert.deepEqual(
      (await EventJournal.readHistory(root, identity)).map((row) => row.eventId),
      [journal.since(0)[0]?.eventId],
    );
    await journal.append(usage(2, "valid", { inputTokens: 5, outputTokens: 3 }));
    assert.equal(
      (await journal.append(usage(2, "valid", { inputTokens: 5, outputTokens: 3 }))).sequence,
      2,
    );
    await journal.close();
    journal = await EventJournal.open(root, identity);
    await assert.rejects(
      journal.append(usage(3, "after-open-invalid", { outputTokens: 3 })),
      /omitted prior metric/,
    );
    await journal.append(usage(3, "after-open-valid", { inputTokens: 6, outputTokens: 3 }));
    assert.equal((await EventJournal.readHistory(root, identity)).length, 3);
    await journal.close();
  }));

test("durability error fences the journal and leaves the last committed cursor readable", async () =>
  fixture(async (root) => {
    const journal = await EventJournal.open(root, identity);
    const source = (sequence: number, inputTokens: number) => ({
      kind: "usage.accounted" as const,
      hostSessionId: identity.hostSessionId,
      runtimeEpoch: identity.runtimeEpoch,
      sequence,
      eventId: `usage-${sequence}`,
      at: sequence,
      turnId: "turn",
      sourceId: "call",
      accounting: "absolute" as const,
      inputTokens,
    });
    await journal.append(source(1, 5));
    const cursor = `${journalPath(root, identity, "events")}.cursor`;
    const saved = `${cursor}.controlled-test-backup`;
    await rename(cursor, saved);
    await mkdir(cursor); // A controlled rename failure after appendFile/fsync, before commit cursor publication.
    await assert.rejects(journal.append(source(2, 6)));
    await rmdir(cursor);
    await rename(saved, cursor);
    assert.deepEqual(
      (await EventJournal.readHistory(root, identity)).map((row) => row.sequence),
      [1],
    );
    await assert.rejects(journal.append(source(2, 7)));
    await journal.close();
    await assert.rejects(EventJournal.open(root, identity), /uncommitted journal tail/);
  }));

test("command admission is durable and restart never replays an uncertain prompt", async () => fixture(async (root) => {
  const command = { type: "send", commandId: "cmd-1", hostSessionId: "host-a", turnId: "turn-1", text: "edit" } as const;
  let journal = await CommandJournal.open(root, identity);
  assert.equal((await journal.accept(command)).status, "accepted");
  assert.equal((await journal.accept(command)).status, "duplicate");
  await journal.close();
  journal = await CommandJournal.open(root, identity);
  assert.equal(journal.query("cmd-1")?.status, "execution-unknown");
  assert.equal((await journal.accept(command)).status, "duplicate");
  await journal.close();
}));

test("same native ID and workspace path cannot collide across targets", async () => fixture(async (root) => {
  const first = await EventJournal.open(root, identity);
  const second = await EventJournal.open(root, { ...identity, targetId: "ssh-b" });
  const event = { kind: "turn.started", hostSessionId: "host-a", runtimeEpoch: "epoch-a", sequence: 1, eventId: "native-1", at: 1, turnId: "turn" } as const;
  await first.append(event);
  assert.equal(second.since(0).length, 0);
  await first.close();
  await second.close();
}));
