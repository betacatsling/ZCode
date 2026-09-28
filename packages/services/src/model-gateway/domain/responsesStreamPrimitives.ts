import type { ModelUsage } from "@zcode/contracts";
import { invalidRequest } from "./errors.js";

export interface MessageOutputItem {
  id: string;
  type: "message";
  role: "assistant";
  status: "in_progress" | "completed";
  content: Array<{ type: "output_text"; text: string; annotations: unknown[] }>;
}

export interface FunctionOutputItem {
  id: string;
  type: "function_call";
  status: "in_progress" | "completed";
  call_id: string;
  name: string;
  arguments: string;
}

export type OutputItem = MessageOutputItem | FunctionOutputItem;
export type ResponsesEvent = Record<string, unknown> & { type: string };

export interface TextState {
  readonly modelId: string;
  readonly index: number;
  readonly item: MessageOutputItem;
  text: string;
}

export interface ToolState {
  readonly callId: string;
  readonly index: number;
  readonly item: FunctionOutputItem;
  arguments: string;
  parsedArguments?: Record<string, unknown>;
  argumentsDone: boolean;
  finalized: boolean;
}

export function parseToolArguments(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalidRequest("tool arguments must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidRequest("tool arguments must decode to an object");
  }
  return value as Record<string, unknown>;
}

export function canonicalJson(value: unknown): string {
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

export function responseUsage(usage: ModelUsage): Record<string, unknown> | undefined {
  const inputTokens =
    usage.inputTokens ?? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  const outputTokens = usage.outputTokens;
  if (
    usage.inputTokens === undefined &&
    usage.cacheReadTokens === undefined &&
    usage.cacheWriteTokens === undefined
  )
    return undefined;
  if (outputTokens === undefined) return undefined;
  return {
    input_tokens: inputTokens,
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { input_tokens_details: { cached_tokens: usage.cacheReadTokens } }),
    output_tokens: outputTokens,
    ...(usage.reasoningTokens === undefined
      ? {}
      : { output_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
    total_tokens: usage.totalTokens ?? inputTokens + outputTokens,
  };
}
