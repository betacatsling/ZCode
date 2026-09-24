import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEvent } from "@zcode/shared/agent-host";
import { EventJournal } from "../src/agent-host/eventJournal.js";
import { CommandJournal } from "../src/agent-host/commandJournal.js";
import { journalPath } from "../src/agent-host/journalStorage.js";
import { publishActivitySummary, readActivitySummary } from "../src/agent-host/activityReadModel.js";
import { projectHostConversation } from "../src/agent-ui-projection/projector.js";

const identity = { targetId: "local", workspaceIdentity: "tree", harnessId: "mock", hostSessionId: "session", runtimeEpoch: "epoch" };
const spec = { schemaVersion: 1 as const, hostSessionId: "session", execution: { targetId: "local", workspaceIdentity: "tree", worktreePath: "/tmp/test" }, harness: { id: "mock", adapterVersion: "1" }, modelBinding: { kind: "harness-managed" as const } };
const event = (sequence: number, kind: AgentEvent["kind"], fields: Record<string, unknown>): AgentEvent =>
  ({ hostSessionId: identity.hostSessionId, runtimeEpoch: identity.runtimeEpoch, eventId: `e-${sequence}`, at: sequence, sequence, kind, ...fields }) as AgentEvent;

test("committed event cursor hides an in-flight partial append and refuses a crashed uncommitted tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-cursor-"));
  try {
    const journal = await EventJournal.open(root, identity);
    await journal.append(event(1, "turn.started", { turnId: "first" }));
    const path = journalPath(root, identity, "events");
    const committed = (await readFile(path)).length;
    await appendFile(path, '{"sequence":2'); // controlled concurrent write before the durable commit cursor
    assert.deepEqual((await EventJournal.readHistory(root, identity)).map((row) => row.sequence), [1]);
    await journal.close();
    await assert.rejects(EventJournal.open(root, identity), /uncommitted journal tail/);
    await truncate(path, committed); // test-only operator repair; production never truncates automatically
    const reopened = await EventJournal.open(root, identity);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("summary is tied to committed journal revisions and invalidates on a write or missing data", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-summary-"));
  try {
    const journal = await EventJournal.open(root, identity);
    const commands = journalPath(root, identity, "commands");
    await writeFile(commands, "");
    await writeFile(`${commands}.cursor`, JSON.stringify({ version: 1, bytes: 0 }));
    await publishActivitySummary(root, identity, { seq: 0, activity: "idle", pendingSend: false });
    assert.equal((await readActivitySummary(root, identity))?.activity, "idle");
    await journal.append(event(1, "turn.started", { turnId: "first" }));
    assert.equal(await readActivitySummary(root, identity), undefined);
    await publishActivitySummary(root, identity, { seq: 1, activity: "running", pendingSend: true });
    assert.equal((await readActivitySummary(root, identity))?.seq, 1);
    await appendFile(journalPath(root, identity, "events"), "incomplete");
    assert.equal(await readActivitySummary(root, identity), undefined);
    await journal.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("100001 committed canonical events validate once, then repeated cold summary polls never replay history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-summary-load-"));
  try {
    const lines = Array.from({ length: 100_001 }, (_, index) => JSON.stringify(event(index + 1, "session.status", { state: "idle" }))).join("\n") + "\n";
    const events = journalPath(root, identity, "events");
    const commands = journalPath(root, identity, "commands");
    await writeFile(events, lines);
    await writeFile(`${events}.cursor`, JSON.stringify({ version: 1, bytes: Buffer.byteLength(lines) }));
    await writeFile(commands, "");
    await writeFile(`${commands}.cursor`, JSON.stringify({ version: 1, bytes: 0 }));
    await publishActivitySummary(root, identity, { seq: 100_001, activity: "idle", pendingSend: false });
    const eventReads = t.mock.method(EventJournal, "readHistory");
    const commandReads = t.mock.method(CommandJournal, "hasUnresolvedHistory");
    assert.equal((await readActivitySummary(root, identity))?.seq, 100_001);
    const heapBeforePolls = process.memoryUsage().heapUsed;
    for (let i = 0; i < 30; i++) assert.equal((await readActivitySummary(root, identity))?.activity, "idle");
    assert.equal(eventReads.mock.callCount(), 1);
    assert.equal(commandReads.mock.callCount(), 1);
    assert.ok(process.memoryUsage().heapUsed - heapBeforePolls < 32 * 1024 * 1024, "summary polling must not retain another full journal");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pagination after 100000 canonical rows preserves oldest rows with a bounded returned page", () => {
  const events: AgentEvent[] = [event(1, "turn.started", { turnId: "t" })];
  for (let sequence = 2; sequence <= 100_002; sequence++)
    events.push(event(sequence, "message.finished", { turnId: "t", messageId: `m${sequence}`, role: "user", text: "x" }));
  const recent = projectHostConversation({ spec, runtimeEpoch: identity.runtimeEpoch, events, rowRange: { limit: 2 } });
  assert.equal(recent.rows.totalCount, 100_002);
  assert.deepEqual(recent.rows.window.map((row) => row.rowId), [100_001, 100_002]);
  const oldest = projectHostConversation({ spec, runtimeEpoch: identity.runtimeEpoch, events, rowRange: { beforeRowId: 3, limit: 2 } });
  assert.deepEqual(oldest.rows.window.map((row) => row.rowId), [1, 2]);
  assert.equal(oldest.seq, recent.seq);
});
