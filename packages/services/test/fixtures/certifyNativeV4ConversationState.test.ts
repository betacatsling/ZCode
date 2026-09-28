import assert from "node:assert/strict";
import test from "node:test";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import type { AgentEvent } from "@zcode/shared/agent-host";
import { projectHostConversation } from "../../src/agent-ui-projection/projector.js";
import { NativeV4ConversationState } from "./certifyNativeV4ConversationState.js";

const hostSessionSpec = {
  schemaVersion: 1 as const,
  hostSessionId: "host-fixture",
  execution: {
    targetId: "local-fixture",
    workspaceIdentity: "workspace-fixture",
    worktreePath: "/tmp/fixture",
  },
  harness: { id: "pi", adapterVersion: "0.87.1" },
  modelBinding: {
    kind: "host-managed" as const,
    selection: { providerId: "fixture", modelId: "fixture" },
  },
};

function event(
  sequence: number,
  kind: AgentEvent["kind"],
  rest: Record<string, unknown>,
): AgentEvent {
  return {
    hostSessionId: "host-fixture",
    runtimeEpoch: "runtime-fixture",
    sequence,
    eventId: `event-${sequence}`,
    at: sequence * 1000,
    kind,
    ...rest,
  } as AgentEvent;
}

test("approvals come from the subscribed snapshot and matching current turn row", () => {
  const snapshot = projectHostConversation({
    spec: hostSessionSpec,
    runtimeEpoch: "runtime-fixture",
    events: [
      event(1, "turn.started", { turnId: "turn-current" }),
      event(2, "message.finished", {
        turnId: "turn-current",
        messageId: "user-current",
        role: "user",
        text: "Write a fixture file",
      }),
      event(3, "tool.started", {
        turnId: "turn-current",
        toolCallId: "tool-current",
        name: "write",
        inputText: '{"path":"output.txt"}',
      }),
      event(4, "interaction.requested", {
        turnId: "turn-current",
        interactionId: "approval-current",
        toolCallId: "tool-current",
        summary: "Write output.txt?",
      }),
    ],
  });
  const matchingPermission = snapshot.pendingInteractions.find(
    (interaction) => interaction.interactionId === "approval-current",
  );
  assert.ok(matchingPermission?.kind === "permission");
  const snapshotWithMismatchedToolCall = {
    ...snapshot,
    pendingInteractions: [
      ...snapshot.pendingInteractions,
      {
        ...matchingPermission,
        interactionId: "approval-wrong-tool-call",
        payload: { ...matchingPermission.payload, toolCallId: "tool-other" },
      },
    ],
  };
  const sessionId = snapshot.sessionId;
  const state = new NativeV4ConversationState(sessionId);
  state.configureSubscription("subscription-current", "runtime-fixture");
  state.acceptNotification({
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind: "initial",
    logicalFrameId: "frame-initial",
    logicalFrameOrdinal: 1,
    topic: `conversation/${sessionId}`,
    subscriptionId: "subscription-current",
    frame: {
      topic: `conversation/${sessionId}`,
      subscriptionId: "subscription-current",
      fromSeq: 0,
      toSeq: snapshotWithMismatchedToolCall.seq,
      sentAt: 10_000,
      payload: { kind: "snapshot", snapshot: snapshotWithMismatchedToolCall },
    },
  });

  state.assertHealthy();
  assert.equal(state.snapshot?.sessionId, sessionId);
  assert.equal(state.snapshot?.logEpoch, "runtime-fixture");
  assert.equal(
    state.pendingPermissionsForTurn("turn-current")[0]?.interaction.interactionId,
    "approval-current",
  );
  state.acceptNotification({
    topic: "sessions-index/workspace-fixture",
    archivedHistory: {
      pendingInteractions: [{ interactionId: "approval-old", kind: "permission" }],
    },
  });
  assert.deepEqual(
    state.pendingPermissionsForTurn("turn-current").map((entry) => entry.interaction.interactionId),
    ["approval-current"],
  );
  assert.deepEqual(state.pendingPermissionsForTurn("turn-old"), []);
});
