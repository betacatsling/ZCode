import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventJournal } from "../src/agent-host/eventJournal.js";
import { CommandJournal } from "../src/agent-host/commandJournal.js";

const identity = {
  targetId: "local-a",
  workspaceIdentity: "workspace-a",
  harnessId: "mock",
  hostSessionId: "host-a",
  runtimeEpoch: "epoch-a",
};

async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "zcode-agent-host-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("event journal de-duplicates source events, detects gaps and replays after restart", async () =>
  fixture(async (root) => {
    const source = {
      kind: "text.delta",
      hostSessionId: "host-a",
      runtimeEpoch: "epoch-a",
      sequence: 1,
      eventId: "native-1",
      at: 1,
      turnId: "turn",
      messageId: "message",
      text: "hi",
    } as const;
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
    assert.deepEqual(
      journal.since(1).map((event) => event.sequence),
      [2],
    );
    await journal.close();
  }));

test("command admission is durable and restart never replays an uncertain prompt", async () =>
  fixture(async (root) => {
    const command = {
      type: "send",
      commandId: "cmd-1",
      hostSessionId: "host-a",
      turnId: "turn-1",
      text: "edit",
    } as const;
    let journal = await CommandJournal.open(root, identity);
    assert.equal((await journal.accept(command)).status, "accepted");
    assert.equal((await journal.accept(command)).status, "duplicate");
    await journal.close();
    journal = await CommandJournal.open(root, identity);
    assert.equal(journal.query("cmd-1")?.status, "execution-unknown");
    assert.equal((await journal.accept(command)).status, "duplicate");
    await journal.close();
  }));

test("same native ID and workspace path cannot collide across targets", async () =>
  fixture(async (root) => {
    const first = await EventJournal.open(root, identity);
    const second = await EventJournal.open(root, { ...identity, targetId: "ssh-b" });
    const event = {
      kind: "turn.started",
      hostSessionId: "host-a",
      runtimeEpoch: "epoch-a",
      sequence: 1,
      eventId: "native-1",
      at: 1,
      turnId: "turn",
    } as const;
    await first.append(event);
    assert.equal(second.since(0).length, 0);
    await first.close();
    await second.close();
  }));
