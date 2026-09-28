import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  ConversationV4Gateway,
  type V4GatewayHost,
} from "./v4-gateway.js";

function gatewayHost(
  listStoredWorkspaceSessionIds: V4GatewayHost["listStoredWorkspaceSessionIds"],
): V4GatewayHost {
  return {
    sessionExists: () => false,
    emitWireFrame: () => undefined,
    executeCommand: async () => undefined,
    listWorkspaceSessionIds: () => [],
    listStoredWorkspaceSessionIds,
  };
}

test("native quiescence is idle only after complete owner enumeration", async () => {
  const params = {
    workspacePath: "/worktree with spaces\n",
    workspaceIdentity: "native-workspace",
    worktreeGeneration: "generation-1",
  };
  const idle = new ConversationV4Gateway(gatewayHost(async () => []));
  try {
    const result = await idle.workspaceAdmissionQuiescence(params);
    assert.equal(result.complete, true);
    assert.equal(result.state, "idle");
    assert.equal(result.worktreeGeneration, "generation-1");
  } finally {
    idle.dispose();
  }

  const dormantHistory = new ConversationV4Gateway(
    gatewayHost(async () => ["persisted-but-unmounted-session"]),
  );
  try {
    const result = await dormantHistory.workspaceAdmissionQuiescence(params);
    assert.equal(result.complete, false);
    assert.equal(result.state, "unknown");
  } finally {
    dormantHistory.dispose();
  }
});

test("native quiescence reads live running and approval state from the V4 owner", async () => {
  const gateway = new ConversationV4Gateway({
    ...gatewayHost(async () => ["session-1"]),
    listWorkspaceSessionIds: () => ["session-1"],
  });
  const event = (
    sequenceNumber: number,
    type: SessionEvent["type"],
    payload: Record<string, unknown>,
  ): SessionEvent =>
    ({
      id: `event-${sequenceNumber}`,
      sessionId: "session-1",
      turnId: "turn-1",
      type,
      timestamp: new Date(sequenceNumber),
      traceId: "trace-1",
      sequenceNumber,
      payload,
    }) as SessionEvent;
  try {
    gateway.ingest(
      "session-1",
      event(1, SessionEventType.TurnStarted, { turnNumber: 1, input: "read and write" }),
    );
    gateway.ingest(
      "session-1",
      event(2, SessionEventType.PermissionRequested, {
        toolCallId: "tool-1",
        toolName: "write_file",
        riskLevel: "high",
        reason: "write requires approval",
        input: { path: "README.md" },
      }),
    );
    const result = await gateway.workspaceAdmissionQuiescence({
      workspacePath: "/worktree",
      workspaceIdentity: "native-workspace",
      worktreeGeneration: "generation-1",
    });
    assert.equal(result.complete, true);
    assert.equal(result.state, "busy");
    assert.equal(result.activeTurnCount, 1);
    assert.equal(result.pendingApprovalCount, 1);
  } finally {
    gateway.dispose();
  }
});
