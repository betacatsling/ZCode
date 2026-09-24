import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, SessionSpecV2 } from "@zcode/shared/agent-host";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { journalPath } from "../src/agent-host/journalStorage.js";
import { manifestPath } from "../src/agent-host/sessionManifest.js";

// No worker or Provider call: persisted manifest + real committed journal, read through production Host history APIs.
test("over 100k committed events page to oldest row; concurrent append never splits seq/revision/rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-projection-history-"));
  const spec: SessionSpecV2 = { schemaVersion: 2, hostSessionId: "history", projectId: "project", workspaceId: "workspace",
    execution: { targetId: "local", workspaceIdentity: "identity", worktreePath: root, worktreeGeneration: "gen", cwdRelativeToWorktree: "." },
    harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding: { kind: "host-managed", selection: { providerId: "provider", modelId: "model" } } };
  const epoch = randomUUID();
  const identity = { targetId: "local", workspaceIdentity: "identity", harnessId: "mock", hostSessionId: "history", runtimeEpoch: epoch };
  const path = journalPath(root, identity, "events");
  const mk = (sequence: number, kind: AgentEvent["kind"], rest: Record<string, unknown>): AgentEvent =>
    ({ hostSessionId: "history", runtimeEpoch: epoch, sequence, eventId: `event-${sequence}`, at: sequence, kind, ...rest }) as AgentEvent;
  const rows: AgentEvent[] = [mk(1, "turn.started", { turnId: "first" })];
  // 100k + 1 committed journal events before paging, plus 206 distinct rows.
  for (let i = 2; i <= 100_002; i++) rows.push(mk(i, "text.delta", { turnId: "first", messageId: "stream", text: "x" }));
  rows.push(mk(100_003, "message.finished", { turnId: "first", messageId: "stream", role: "assistant", text: "terminal" }));
  for (let i = 100_004; i <= 100_208; i++) rows.push(mk(i, "message.finished", { turnId: "first", messageId: `user-${i}`, role: "user", text: `${i}` }));
  rows.push(mk(100_209, "turn.finished", { turnId: "first", outcome: "success" }));
  let bytes = 0;
  const commit = async (content: string) => {
    await writeFile(path, content, { flag: "a" });
    bytes += Buffer.byteLength(content);
    const temporary = `${path}.cursor.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, bytes }));
    await rename(temporary, `${path}.cursor`);
  };
  try {
    await writeFile(manifestPath(root, spec), JSON.stringify({ schemaVersion: 2, state: "running", spec,
      plan: { schemaVersion: 1, hostSessionId: "history", targetId: "local", harnessId: "mock", adapterVersion: "1.0.0",
        catalogFingerprint: "fixture", requested: spec.modelBinding, effective: spec.modelBinding.selection, route: "mock",
        support: { support: "supported" }, capabilities: {} }, binding: { schemaVersion: 2, targetId: "local", workspaceId: "workspace", worktreeGeneration: "gen",
        harnessId: "mock", hostSessionId: "history", backendSessionId: "mock-history", backendVersion: "1.0.0", runtimeEpoch: epoch } }));
    await commit(`${rows.map((e) => JSON.stringify(e)).join("\n")}\n`);
    const first = await SessionHost.snapshotHistory(root, spec);
    assert.equal(first.seq, rows.length);
    assert.equal(first.rows.totalCount, 207);
    assert.equal(first.rows.window[0]?.rowId, 108);
    const tail = await SessionHost.rowsRangeHistory(root, spec, { sessionId: "history", limit: 200 });
    assert.deepEqual([tail.atSeq, tail.atRevision, tail.rows[0]?.rowId, tail.rows.at(-1)?.rowId, tail.hasMore], [rows.length, rows.length, 8, 207, true]);
    const oldest = await SessionHost.rowsRangeHistory(root, spec, { sessionId: "history", beforeRowId: 8, limit: 200 });
    assert.deepEqual([oldest.rows[0]?.rowId, oldest.rows.at(-1)?.rowId, oldest.hasMore], [1, 7, false]);
    assert.equal(oldest.rows[1]?.kind === "assistantText" && oldest.rows[1].text, "terminal");

    // Commit another turn while a real journal read is in flight. Both valid linearizations are acceptable;
    // an uncommitted tail is never visible, and each page's watermark must match the rows it projected.
    const pending = SessionHost.rowsRangeHistory(root, spec, { sessionId: "history", limit: 1 });
    const next = mk(rows.length + 1, "turn.started", { turnId: "second" });
    await commit(`${JSON.stringify(next)}\n`);
    const racing = await pending;
    assert.ok(racing.atSeq === rows.length || racing.atSeq === rows.length + 1);
    assert.equal(racing.atRevision, racing.atSeq);
    assert.equal(racing.rows.at(-1)?.rowId, racing.atSeq === rows.length ? 207 : 208);
    const newer = await SessionHost.rowsRangeHistory(root, spec, { sessionId: "history", limit: 1 });
    assert.equal(newer.atSeq, rows.length + 1);
    assert.equal(newer.rows[0]?.rowId, 208);
    assert.equal(newer.atLogEpoch, oldest.atLogEpoch);
    assert.ok(oldest.atRevision < newer.atRevision); // UI must fence stale pages by epoch/cursor/revision.
    // Legacy terminal-only child observed after its own turn and repeated in another active turn.
    await commit([mk(rows.length + 2, "subagent.updated", { turnId: "first", childSessionId: "legacy-child", status: "finished", summary: "first observation" }),
      mk(rows.length + 3, "subagent.updated", { turnId: "first", childSessionId: "legacy-child", status: "finished", summary: "later observation" }),
      mk(rows.length + 4, "turn.finished", { turnId: "second", outcome: "success" })].map((row) => `${JSON.stringify(row)}\n`).join(""));
    const history = await SessionHost.snapshotHistory(root, spec);
    const child = history.rows.window.find((row) => row.kind === "subagent");
    assert.equal(child?.kind === "subagent" && child.summaryText, "later observation");
    assert.equal(child?.kind === "subagent" && child.startedAt, undefined);
    assert.equal(history.subagents.endedTotal, 1);
    const historyPage = await SessionHost.rowsRangeHistory(root, spec, { sessionId: "history", beforeRowId: 210, limit: 1 });
    assert.equal(historyPage.rows[0]?.kind, "subagent");
    assert.equal(historyPage.rows[0]?.rowId, 209);
    const tailBeforeCursor = await readFile(path);
    await writeFile(path, `${JSON.stringify(mk(rows.length + 5, "turn.started", { turnId: "uncommitted" }))}\n`, { flag: "a" });
    assert.equal((await SessionHost.snapshotHistory(root, spec)).seq, history.seq);
    assert.ok((await readFile(path)).length > tailBeforeCursor.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});
