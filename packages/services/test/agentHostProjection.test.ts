import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import type { AgentEvent } from "@zcode/shared/agent-host";
import { projectHostConversation } from "../src/agent-ui-projection/projector.js";

const spec = {
  schemaVersion: 1 as const, hostSessionId: "host-1",
  execution: { targetId: "local-1", workspaceIdentity: "workspace-1", worktreePath: "/tmp/test" },
  harness: { id: "pi", adapterVersion: "0.87.1" },
  modelBinding: { kind: "host-managed" as const, selection: { providerId: "provider-a", modelId: "model-a" } },
};
const epoch = randomUUID();
function event(sequence: number, kind: AgentEvent["kind"], rest: Record<string, unknown>): AgentEvent {
  return { hostSessionId: "host-1", runtimeEpoch: epoch, sequence, eventId: `evt-${sequence}`, at: sequence * 1000, kind, ...rest } as AgentEvent;
}

test("external V4 projection replaces text deltas with terminal message; approval state survives replay", () => {
  const events = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "hel" }),
    event(3, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "lo" }),
    event(4, "message.finished", { turnId: "turn-1", messageId: "message-1", role: "assistant", text: "hello" }),
    event(5, "tool.started", { turnId: "turn-1", toolCallId: "tool-1", name: "write", inputText: "{\"path\":" }),
    event(6, "interaction.requested", { turnId: "turn-1", interactionId: "approval-1", toolCallId: "tool-1", summary: "Write file?" }),
  ];
  const snapshot = projectHostConversation({ spec, runtimeEpoch: epoch, events });
  assert.deepEqual(conversationSnapshotSchema.parse(snapshot), snapshot);
  const row = snapshot.rows.window.find((row) => row.kind === "assistantText");
  assert.equal(row?.kind === "assistantText" && row.text, "hello");
  assert.equal(snapshot.rows.window.filter((item) => item.kind === "assistantText").length, 1);
  assert.equal(snapshot.pendingInteractions[0]?.interactionId, "approval-1");
  assert.equal(snapshot.rows.window.find((item) => item.kind === "toolCall")?.kind, "toolCall");
  const after = projectHostConversation({ spec, runtimeEpoch: epoch, events: [
    ...events,
    event(7, "interaction.resolved", { turnId: "turn-1", interactionId: "approval-1", decision: "deny" }),
    event(8, "turn.finished", { turnId: "turn-1", outcome: "success" }),
  ] });
  assert.equal(after.pendingInteractions.length, 0);
  assert.equal(after.control.canStop, false);
  assert.equal(after.seq, 8);
  assert.equal(after.agentHost?.harnessId, "pi");
});

test("a bounded external rows window exposes its real first row for pagination", () => {
  const events = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "message.finished", { turnId: "turn-1", messageId: "user-1", role: "user", text: "hi" }),
    event(3, "message.finished", { turnId: "turn-1", messageId: "assistant-1", role: "assistant", text: "hello" }),
    event(4, "turn.finished", { turnId: "turn-1", outcome: "success" }),
  ];
  const snapshot = projectHostConversation({ spec, runtimeEpoch: epoch, events, windowSize: 2 });
  assert.equal(snapshot.rows.totalCount, 3);
  assert.deepEqual(snapshot.rows.window.map((row) => row.rowId), [2, 3]);
  assert.equal(snapshot.rows.firstRowId, 2);
});

test("projection refuses gaps, foreign events or duplicated sequence", () => {
  assert.throws(() => projectHostConversation({ spec, runtimeEpoch: epoch, events: [event(2, "turn.started", { turnId: "t" })] }), /sequence/);
  assert.throws(() => projectHostConversation({ spec, runtimeEpoch: epoch, events: [event(1, "turn.started", { turnId: "t" }), event(1, "turn.started", { turnId: "t" })] }), /sequence/);
});

test("mixed transcript projects visible reasoning, structured plan, child, question and source-accounted cache without duplicate totals", () => {
  const turnId = "mixed";
  const common = { turnId };
  const events: AgentEvent[] = [
    event(1, "turn.started", common),
    event(2, "message.finished", { ...common, messageId: "user", role: "user", text: "inspect" }),
    event(3, "reasoning.started", { ...common, messageId: "thinking" }),
    event(4, "reasoning.delta", { ...common, messageId: "thinking", text: "partial PRIVATE?" }),
    event(5, "reasoning.finished", { ...common, messageId: "thinking", text: "visible final" }),
    event(6, "text.delta", { ...common, messageId: "answer", text: "draft" }),
    event(7, "message.finished", { ...common, messageId: "answer", role: "assistant", text: "final" }),
    event(8, "tool.started", { ...common, toolCallId: "tool", name: "read" }),
    event(9, "tool.finished", { ...common, toolCallId: "tool", name: "read", outcome: "success" }),
    event(10, "plan.updated", { ...common, text: "legacy unstructured note" }),
    event(11, "plan.itemsUpdated", { ...common, items: [{ id: "step", content: "Review", status: "inProgress" }] }),
    event(12, "subagent.updated", { ...common, childSessionId: "child", childHarnessId: "pi", parentToolCallId: "tool", status: "started" }),
    event(13, "subagent.updated", { ...common, childSessionId: "child", childHarnessId: "pi", status: "finished", summary: "done" }),
    event(14, "usage.accounted", { ...common, sourceId: "call-1", accounting: "absolute", inputTokens: 10, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 2, reasoningTokens: 3 }),
    event(15, "usage.accounted", { ...common, sourceId: "call-1", accounting: "absolute", inputTokens: 12, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 2, reasoningTokens: 3 }),
    event(16, "usage.accounted", { ...common, sourceId: "call-2", accounting: "delta", inputTokens: 4, outputTokens: 1 }),
    event(17, "question.requested", { ...common, interactionId: "question", prompt: "Which?", freeText: false, options: [{ optionId: "a", label: "First" }] }),
  ];
  const pending = projectHostConversation({ spec, runtimeEpoch: epoch, events, windowSize: 2 });
  assert.deepEqual(pending.usage.cumulative, { inputTokens: 16, outputTokens: 7, cacheReadTokens: 7, cacheWriteTokens: 2 });
  assert.equal(pending.pendingInteractions[0]?.kind, "userInput");
  assert.equal(pending.plan?.items[0]?.id, "step");
  assert.equal(pending.subagents.endedTotal, 1);
  assert.equal(pending.rows.totalCount, 6);
  assert.deepEqual(pending.rows.window.map((row) => row.rowId), [5, 6]);
  const done = projectHostConversation({ spec, runtimeEpoch: epoch, events: [
    ...events, event(18, "question.answered", { ...common, interactionId: "question" }),
    event(19, "turn.finished", { ...common, outcome: "success" }),
  ] });
  assert.equal(done.pendingInteractions.length, 0);
  assert.equal(done.rows.window.find((row) => row.kind === "reasoning")?.text, "visible final");
  assert.equal(done.rows.window.find((row) => row.kind === "assistantText")?.text, "final");
  assert.equal(done.rows.window.find((row) => row.kind === "subagent")?.status, "success");
  assert.throws(() => projectHostConversation({ spec, runtimeEpoch: epoch, events: [...events, event(18, "usage.accounted", { ...common, sourceId: "call-2", accounting: "delta", inputTokens: 4 })] }), /duplicate usage/);
  assert.throws(() => projectHostConversation({ spec, runtimeEpoch: epoch, events: [...events, event(18, "interaction.resolved", { ...common, interactionId: "question", decision: "allow" })] }), /stale approval/);
  assert.throws(() => projectHostConversation({ spec, runtimeEpoch: epoch, events: [...events, event(18, "question.answered", { ...common, interactionId: "stale" })] }), /stale question/);
});
