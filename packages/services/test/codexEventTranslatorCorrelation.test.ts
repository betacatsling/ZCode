import assert from "node:assert/strict";
import test from "node:test";
import { translateCodexNotification } from "../src/agent-adapters/codex/codexEventTranslator.js";
import type {
  CodexActiveTurn,
  CodexSessionRuntime,
} from "../src/agent-adapters/codex/codexRuntime.js";
import type { AgentEvent } from "@zcode/shared/agent-host";

function turn(hostTurnId: string, backendTurnId: string): CodexActiveTurn {
  return {
    hostTurnId,
    backendTurnId,
    started: true,
    completion: {
      promise: Promise.resolve(),
      resolve() {},
      reject() {},
    },
  };
}

test("Codex native message and tool item IDs are scoped to their Host turn", () => {
  const events: Array<{ kind: AgentEvent["kind"]; fields: Record<string, unknown> }> = [];
  const runtime = {
    threadId: "opaque-thread",
    activeTurn: turn("host-turn-one", "backend-turn-one"),
    messages: new Map<string, string>(),
    tools: new Map<string, "exec_command" | "file_change">(),
    emit(kind: AgentEvent["kind"], fields: Record<string, unknown>) {
      events.push({ kind, fields });
    },
  } as unknown as CodexSessionRuntime;

  const notify = (turnId: string, hostTurnId: string, method: string, params: unknown) => {
    runtime.activeTurn = turn(hostTurnId, turnId);
    translateCodexNotification(runtime, method, params, () => undefined);
  };
  for (const [turnId, hostTurnId, toolType] of [
    ["backend-turn-one", "host-turn-one", "commandExecution"],
    ["backend-turn-two", "host-turn-two", "fileChange"],
  ] as const) {
    notify(turnId, hostTurnId, "item/started", {
      threadId: "opaque-thread",
      turnId,
      item: { id: "reused-item-id", type: toolType },
    });
    notify(turnId, hostTurnId, "item/completed", {
      threadId: "opaque-thread",
      turnId,
      item: {
        id: "reused-item-id",
        type: toolType,
        status: "completed",
        exitCode: 0,
        changes: [],
      },
    });
    notify(turnId, hostTurnId, "item/agentMessage/delta", {
      threadId: "opaque-thread",
      turnId,
      itemId: "reused-message-id",
      delta: `answer-${hostTurnId}`,
    });
    notify(turnId, hostTurnId, "item/completed", {
      threadId: "opaque-thread",
      turnId,
      item: { id: "reused-message-id", type: "agentMessage" },
    });
  }

  const toolsStarted = events.filter((event) => event.kind === "tool.started");
  assert.deepEqual(
    toolsStarted.map((event) => event.fields.toolCallId),
    ["codex:host-turn-one:reused-item-id", "codex:host-turn-two:reused-item-id"],
  );
  const messagesFinished = events.filter((event) => event.kind === "message.finished");
  assert.deepEqual(
    messagesFinished.map((event) => [event.fields.messageId, event.fields.text]),
    [
      ["codex:host-turn-one:reused-message-id", "answer-host-turn-one"],
      ["codex:host-turn-two:reused-message-id", "answer-host-turn-two"],
    ],
  );
  assert.deepEqual(runtime.tools, new Map());
  assert.deepEqual(runtime.messages, new Map());
});
