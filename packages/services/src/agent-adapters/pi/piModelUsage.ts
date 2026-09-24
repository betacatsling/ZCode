import type { Usage } from "@earendil-works/pi-ai";

export const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

export function toUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): Usage {
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
