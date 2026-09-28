import type { ModelUsage } from "@zcode/contracts";
import { invalidRequest } from "../domain/errors.js";

export function outputTokenCount(usage: ModelUsage): number | undefined {
  const fields = [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
  ];
  for (const value of fields) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Bound model returned invalid token usage");
    }
  }
  return usage.outputTokens;
}

export function encodeResponsesSse(event: Record<string, unknown> & { type: string }): Uint8Array {
  return new TextEncoder().encode(
    "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n",
  );
}

export function parseResponsesJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    invalidRequest("Request body must be valid JSON");
  }
}
