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
