import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

// SDK-required zero-filled Usage is display state, not evidence of a measured counter.
// The original terminal message is passed through the Pi SDK without copying it.
type CanonicalUsageMetrics = Omit<ModelUsage, "totalTokens">;
const measuredMessages = new WeakMap<AssistantMessage, CanonicalUsageMetrics>();
const canonicalKeys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

export function markMeasuredUsage(message: AssistantMessage, usage: ModelUsage): void {
  const measured: CanonicalUsageMetrics = {};
  for (const key of canonicalKeys) {
    const value = usage[key];
    // Preserve explicit zero, but do not invent a field from Pi's initialized defaults.
    if (Object.hasOwn(usage, key) && typeof value === "number") measured[key] = value;
  }
  if (Object.keys(measured).length) measuredMessages.set(message, measured);
}

export function measuredCanonicalUsage(
  message: AssistantMessage,
): CanonicalUsageMetrics | undefined {
  return measuredMessages.get(message);
}

export const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export function toUsage(usage: ModelUsage): Usage {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: usage.reasoningTokens,
    totalTokens: usage.totalTokens ?? input + output,
    cost: { ...EMPTY_COST },
  };
}
