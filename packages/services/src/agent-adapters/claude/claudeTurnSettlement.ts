import type { TargetModelGateway } from "@zcode/services/model-gateway";
import { denyPendingClaudeApprovals } from "./claudeHostApproval.js";
import type { ClaudeActiveTurn, ClaudeSessionRuntime } from "./claudeRuntime.js";
import type { ClaudeSessionRegistry } from "./claudeSessionRegistry.js";

export function finishClaudeTurn(
  runtime: ClaudeSessionRuntime,
  turn: ClaudeActiveTurn,
  result: Record<string, unknown>,
): void {
  if (runtime.activeTurn !== turn) return;
  const outcome = result.zcodeOutcome === "cancelled"
    ? "cancelled"
    : result.is_error === true || result.subtype !== "success"
      ? "failed"
      : "success";
  const failed = outcome === "failed";
  if (!turn.started) {
    turn.started = true;
    runtime.emit("turn.started", { turnId: turn.hostTurnId });
  }
  if (failed)
    runtime.emit("session.error", {
      code: "claude-turn-failed",
      message: "Claude Code reported that the accepted turn failed.",
    });
  const usage = asRecord(result.usage);
  const baseInput = safeTokenCount(usage?.input_tokens);
  const cacheRead = safeTokenCount(usage?.cache_read_input_tokens) ?? 0;
  const cacheCreate = safeTokenCount(usage?.cache_creation_input_tokens) ?? 0;
  const output = safeTokenCount(usage?.output_tokens);
  if (baseInput !== undefined && output !== undefined) {
    runtime.emit("usage.reported", {
      turnId: turn.hostTurnId,
      inputTokens: baseInput + cacheRead + cacheCreate,
      outputTokens: output,
    });
  }
  runtime.emit("turn.finished", {
    turnId: turn.hostTurnId,
    outcome,
  });
  denyPendingClaudeApprovals(runtime);
  runtime.activeTurn = undefined;
  runtime.toolCalls.clear();
  runtime.toolBlocks.clear();
  runtime.activeNativeMessageId = undefined;
  runtime.resolvedInteractionIds.clear();
  runtime.emit("session.status", { state: "idle" });
  turn.completion.resolve();
}

export function markClaudeTurnUnknown(
  runtime: ClaudeSessionRuntime,
  turn: ClaudeActiveTurn,
  message: string,
): void {
  if (runtime.activeTurn !== turn) return;
  if (!turn.started) {
    turn.started = true;
    runtime.emit("turn.started", { turnId: turn.hostTurnId });
  }
  runtime.emit("session.error", { code: "execution-unknown", message });
  runtime.emit("turn.finished", { turnId: turn.hostTurnId, outcome: "unknown" });
  denyPendingClaudeApprovals(runtime);
  runtime.activeTurn = undefined;
  runtime.failed = new Error("Claude accepted input may have executed; inspect history before recovery");
  runtime.toolCalls.clear();
  runtime.toolBlocks.clear();
  turn.completion.reject(runtime.failed);
}

export function failClaudeRuntime(runtime: ClaudeSessionRuntime, error: Error): void {
  if (runtime.stopping || runtime.failed) return;
  runtime.failed = error;
  runtime.gateway.revoke(runtime.grant.id);
  if (runtime.activeTurn) {
    markClaudeTurnUnknown(
      runtime,
      runtime.activeTurn,
      "Claude Code stopped before confirming the accepted turn outcome.",
    );
  } else {
    runtime.emit("session.error", {
      code: "claude-process-failure",
      message: "Claude Code process exited unexpectedly; resume will not resend Host input.",
    });
  }
  denyPendingClaudeApprovals(runtime);
}

export async function stopClaudeRuntime(runtime: ClaudeSessionRuntime): Promise<void> {
  if (runtime.stopPromise) return runtime.stopPromise;
  if (runtime.stopping) return;
  runtime.stopping = true;
  if (runtime.activeTurn)
    markClaudeTurnUnknown(runtime, runtime.activeTurn, "Claude session stopped before its turn outcome was known.");
  denyPendingClaudeApprovals(runtime);
  if (runtime.turnLeaseTimer) clearInterval(runtime.turnLeaseTimer);
  runtime.gateway.revoke(runtime.grant.id);
  runtime.stopPromise = (async () => {
    await runtime.hookServer.close();
    await runtime.process.terminate();
  })();
  await runtime.stopPromise;
}

export async function shutdownClaudeSessions(
  registry: ClaudeSessionRegistry,
  targetGateway: TargetModelGateway,
  ownsTargetGateway: boolean,
): Promise<void> {
  const pendingStarts = registry.pendingStarts();
  const started = await Promise.allSettled(pendingStarts);
  const current = new Set(registry.values());
  for (const result of started) if (result.status === "fulfilled") current.add(result.value);
  await Promise.all([...current].map((runtime) => stopClaudeRuntime(runtime)));
  if (ownsTargetGateway) await targetGateway.close();
  registry.clear();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
