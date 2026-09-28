import { randomUUID } from "node:crypto";
import type { AgentCommand } from "@zcode/shared/agent-host";
import type { ClaudePreToolUseInput, ClaudeHookDecision } from "./claudeApprovalHookServer.js";
import { createClaudeDecision, type ClaudePendingApproval, type ClaudeSessionRuntime } from "./claudeRuntime.js";

export async function requestClaudeApproval(
  runtime: ClaudeSessionRuntime,
  input: ClaudePreToolUseInput,
  signal: AbortSignal,
): Promise<ClaudeHookDecision> {
  const turn = runtime.activeTurn;
  const tool = runtime.toolCalls.get(input.tool_use_id);
  if (
    runtime.stopping ||
    runtime.failed ||
    !turn ||
    input.session_id !== runtime.binding.backendSessionId ||
    !tool ||
    tool.name !== input.tool_name ||
    !tool.input ||
    !sameJsonSubset(tool.name, tool.input, input.tool_input) ||
    (tool.name === "Bash" && isRecord(input.tool_input) && input.tool_input.dangerouslyDisableSandbox === true) ||
    turn.requestedToolIds.has(input.tool_use_id)
  ) {
    runtime.emit("session.error", {
      code: "claude-approval-correlation",
      message: "Claude requested a stale, repeated or mismatched tool approval.",
    });
    return "deny";
  }
  turn.requestedToolIds.add(input.tool_use_id);
  const deferred = createClaudeDecision();
  const interactionId = randomUUID();
  const pending: ClaudePendingApproval = {
    nativeToolUseId: input.tool_use_id,
    interactionId,
    toolCallId: tool.hostToolCallId,
    hostTurnId: turn.hostTurnId,
    runtimeEpoch: runtime.binding.runtimeEpoch,
    decision: deferred.promise,
    decide: deferred.decide,
    state: "pending",
  };
  runtime.pendingApprovals.set(interactionId, pending);
  runtime.emit("interaction.requested", {
    turnId: turn.hostTurnId,
    interactionId,
    toolCallId: tool.hostToolCallId,
    summary: `${tool.name}: ${JSON.stringify(input.tool_input).slice(0, 2_000)}`,
  });
  const abort = () => {
    pending.state = "resolved";
    pending.decide("deny");
    runtime.pendingApprovals.delete(interactionId);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const decision = await pending.decision;
    if (decision === "allow") turn.approvedToolIds.add(input.tool_use_id);
    return decision;
  } finally {
    signal.removeEventListener("abort", abort);
    runtime.pendingApprovals.delete(interactionId);
  }
}

export function resolveClaudeApproval(
  runtime: ClaudeSessionRuntime,
  command: Extract<AgentCommand, { type: "resolveInteraction" }>,
): void {
  if (runtime.binding.runtimeEpoch !== command.runtimeEpoch)
    throw new Error("stale Claude runtime epoch");
  const pending = runtime.pendingApprovals.get(command.interactionId);
  const turn = runtime.activeTurn;
  if (
    !pending ||
    pending.state !== "pending" ||
    pending.runtimeEpoch !== command.runtimeEpoch ||
    pending.hostTurnId !== command.turnId ||
    !turn ||
    turn.hostTurnId !== command.turnId ||
    runtime.resolvedInteractionIds.has(command.interactionId)
  ) {
    throw new Error("Claude interaction is stale or already resolved");
  }
  pending.state = "resolved";
  runtime.resolvedInteractionIds.add(command.interactionId);
  runtime.emit("interaction.resolved", {
    turnId: turn.hostTurnId,
    interactionId: command.interactionId,
    decision: command.decision,
  });
  if (!pending.decide(command.decision)) throw new Error("Claude interaction already has a winner");
}

export function denyPendingClaudeApprovals(runtime: ClaudeSessionRuntime): void {
  for (const pending of runtime.pendingApprovals.values()) {
    if (pending.state !== "pending") continue;
    pending.state = "resolved";
    pending.decide("deny");
  }
  runtime.pendingApprovals.clear();
}

function sameJsonSubset(toolName: string, expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== "object" || Array.isArray(expected))
    return canonicalJson(expected) === canonicalJson(actual);
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
  const left = expected as Record<string, unknown>;
  const right = actual as Record<string, unknown>;
  if (
    !Object.entries(left).every(
      ([key, value]) => Object.hasOwn(right, key) && canonicalJson(value) === canonicalJson(right[key]),
    )
  ) {
    return false;
  }
  return Object.entries(right).every(([key, value]) => {
    if (Object.hasOwn(left, key)) return true;
    if (toolName !== "Bash") return false;
    if (key === "description") return typeof value === "string" && value.length <= 16_000;
    if (key === "timeout") return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 300_000;
    if (key === "run_in_background" || key === "dangerouslyDisableSandbox") return value === false;
    return false;
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
