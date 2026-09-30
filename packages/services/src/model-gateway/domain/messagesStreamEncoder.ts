import type { ModelStreamEvent, ModelUsage, ModelToolCall } from "@zcode/contracts";
import { invalidRequest, unsupportedFeature } from "./errors.js";

export type MessagesEvent = Record<string, unknown> & { readonly type: string };

interface TextBlockState {
  readonly kind: "text";
  readonly id: string;
  readonly index: number;
  closed: boolean;
}

interface ToolBlockState {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly index: number;
  argumentsText: string;
  input?: Record<string, unknown>;
  closed: boolean;
}

type BlockState = TextBlockState | ToolBlockState;

function validTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

function usageSnapshot(usage: ModelUsage, outputTokens: number): Record<string, unknown> {
  if (!validTokenCount(usage.inputTokens))
    unsupportedFeature("bound Model did not report provider input-token usage");
  if (!validTokenCount(outputTokens))
    unsupportedFeature("bound Model did not report provider output-token usage");
  const cacheRead = usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens;
  const reasoning = usage.reasoningTokens;
  for (const value of [cacheRead, cacheWrite, reasoning]) {
    if (value !== undefined && !validTokenCount(value))
      invalidRequest("bound Model returned invalid usage");
  }
  if (reasoning !== undefined && reasoning > outputTokens)
    invalidRequest("bound Model returned inconsistent reasoning usage");
  return {
    input_tokens: usage.inputTokens,
    output_tokens: outputTokens,
    ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_creation_input_tokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { output_tokens_details: { thinking_tokens: reasoning } }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (isRecord(value)) {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

export class MessagesStreamEncoder {
  readonly #allowedTools: ReadonlySet<string>;
  readonly #maxArgumentBytes: number;
  readonly #maxOutputTokens: number;
  readonly #activeTextBlocks = new Map<string, TextBlockState>();
  readonly #toolBlocks = new Map<string, ToolBlockState>();
  readonly #seenToolIds = new Set<string>();
  #nextIndex = 0;
  #started = false;
  #toolCallCount = 0;

  constructor(input: {
    readonly responseId: string;
    readonly model: string;
    readonly allowedTools: ReadonlySet<string>;
    readonly maxArgumentBytes: number;
    readonly maxOutputTokens: number;
    readonly startUsage: ModelUsage;
  }) {
    this.responseId = input.responseId;
    this.model = input.model;
    this.#allowedTools = input.allowedTools;
    this.#maxArgumentBytes = input.maxArgumentBytes;
    this.#maxOutputTokens = input.maxOutputTokens;
    this.startUsage = input.startUsage;
  }

  readonly responseId: string;
  readonly model: string;
  readonly startUsage: ModelUsage;

  start(): MessagesEvent[] {
    if (this.#started) throw new Error("Messages stream was started twice");
    this.#started = true;
    return [
      {
        type: "message_start",
        message: {
          id: this.responseId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: usageSnapshot(this.startUsage, this.startUsage.outputTokens ?? 0),
        },
      },
    ];
  }

  push(event: ModelStreamEvent): MessagesEvent[] {
    if (!this.#started) throw new Error("Messages stream has not been started");
    switch (event.type) {
      case "start":
      case "finish":
      case "compact_stream_boundary":
        return [];
      case "text_start":
        return this.#startText(event.id);
      case "text_delta":
        return this.#textDelta(event.id, event.text);
      case "text_end":
        return this.#endText(event.id);
      case "tool_input_start":
        return this.#startTool(event.id, event.toolName);
      case "tool_input_delta":
        return this.#toolDelta(event.id, event.delta);
      case "tool_input_end":
        return this.#endTool(event.id);
      case "tool_call":
        return this.#completeToolCall(event.toolCall);
      case "reasoning_start":
      case "reasoning_delta":
      case "reasoning_end":
        return unsupportedFeature(
          "bound Model reasoning cannot be emitted as unsigned Messages thinking",
        );
    }
    return unsupportedFeature("bound Model stream event is not supported by Messages");
  }

  finish(event: Extract<ModelStreamEvent, { type: "finish" }>): MessagesEvent[] {
    if (!this.#started) throw new Error("Messages stream has not been started");
    if ([...this.#activeTextBlocks.values()].some((block) => !block.closed))
      invalidRequest("bound Model finished with an open text block");
    if ([...this.#toolBlocks.values()].some((block) => !block.closed))
      invalidRequest("bound Model finished with an open tool block");
    if (!validTokenCount(event.usage.outputTokens))
      unsupportedFeature("bound Model did not report provider output-token usage");
    if (event.usage.outputTokens > this.#maxOutputTokens)
      unsupportedFeature("bound Model exceeded the session output-token reservation");
    if (
      (event.usage.serverToolUse?.webFetchRequests ?? 0) > 0 ||
      (event.usage.serverToolUse?.webSearchRequests ?? 0) > 0
    )
      unsupportedFeature("bound Model usage includes unsupported server tools");

    const stopReason =
      event.finishReason === "stop"
        ? "end_turn"
        : event.finishReason === "tool-calls"
          ? "tool_use"
          : event.finishReason === "length"
            ? "max_tokens"
            : undefined;
    if (!stopReason) unsupportedFeature("bound Model finish reason is not supported by Messages");
    if ((stopReason === "tool_use") !== this.#toolCallCount > 0)
      invalidRequest("bound Model tool calls and finish reason disagree");
    return [
      {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: usageSnapshot(event.usage, event.usage.outputTokens),
      },
      { type: "message_stop" },
    ];
  }

  #startText(id: string): MessagesEvent[] {
    this.#requireId(id);
    if (this.#activeTextBlocks.has(id)) invalidRequest("duplicate bound Model text block id");
    const state: TextBlockState = { kind: "text", id, index: this.#nextIndex++, closed: false };
    this.#activeTextBlocks.set(id, state);
    return [
      {
        type: "content_block_start",
        index: state.index,
        content_block: { type: "text", text: "" },
      },
    ];
  }

  #textDelta(id: string | undefined, text: string): MessagesEvent[] {
    if (typeof text !== "string") invalidRequest("bound Model text delta is invalid");
    const state = id ? this.#activeTextBlocks.get(id) : undefined;
    if (!state || state.closed) invalidRequest("bound Model text delta has no active block");
    return [
      { type: "content_block_delta", index: state.index, delta: { type: "text_delta", text } },
    ];
  }

  #endText(id: string): MessagesEvent[] {
    const state = this.#activeTextBlocks.get(id);
    if (!state || state.closed) invalidRequest("bound Model text block ended more than once");
    state.closed = true;
    return [{ type: "content_block_stop", index: state.index }];
  }

  #startTool(id: string, name: string): MessagesEvent[] {
    this.#requireId(id);
    if (!this.#allowedTools.has(name))
      unsupportedFeature("bound Model selected a tool not declared by Claude");
    if (this.#seenToolIds.has(id)) invalidRequest("bound Model reused a tool call id");
    this.#seenToolIds.add(id);
    const state: ToolBlockState = {
      kind: "tool",
      id,
      name,
      index: this.#nextIndex++,
      argumentsText: "",
      closed: false,
    };
    this.#toolBlocks.set(id, state);
    return [
      {
        type: "content_block_start",
        index: state.index,
        content_block: { type: "tool_use", id, name, input: {} },
      },
    ];
  }

  #toolDelta(id: string, delta: string): MessagesEvent[] {
    const state = this.#toolBlocks.get(id);
    if (!state || state.closed) invalidRequest("bound Model tool delta has no active block");
    if (
      typeof delta !== "string" ||
      new TextEncoder().encode(state.argumentsText + delta).byteLength > this.#maxArgumentBytes
    )
      invalidRequest("bound Model tool arguments exceed the session limit");
    state.argumentsText += delta;
    return [
      {
        type: "content_block_delta",
        index: state.index,
        delta: { type: "input_json_delta", partial_json: delta },
      },
    ];
  }

  #endTool(id: string): MessagesEvent[] {
    const state = this.#toolBlocks.get(id);
    if (!state || state.closed) invalidRequest("bound Model tool block ended more than once");
    state.input = parseToolInput(state.argumentsText);
    assertSupportedToolInput(state.name, state.input);
    state.closed = true;
    this.#toolCallCount += 1;
    return [{ type: "content_block_stop", index: state.index }];
  }

  #completeToolCall(call: ModelToolCall): MessagesEvent[] {
    const state = this.#toolBlocks.get(call.id);
    if (state) {
      if (!state.closed || state.name !== call.name || !sameJson(state.input, call.input))
        invalidRequest("bound Model tool-call summary differs from its streamed arguments");
      return [];
    }
    const start = this.#startTool(call.id, call.name);
    const delta = JSON.stringify(call.input);
    const body = this.#toolDelta(call.id, delta);
    return [...start, ...body, ...this.#endTool(call.id)];
  }

  #requireId(id: string): void {
    if (typeof id !== "string" || !id || id.length > 256)
      invalidRequest("bound Model emitted an invalid stream id");
  }
}

function parseToolInput(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalidRequest("bound Model tool arguments are not valid JSON");
  }
  if (!isRecord(value)) invalidRequest("bound Model tool arguments must be a JSON object");
  return value;
}

function assertSupportedToolInput(name: string, input: Record<string, unknown>): void {
  if (name === "Bash") {
    if (input.dangerouslyDisableSandbox === true)
      unsupportedFeature("Claude Bash requests that disable the local sandbox are not supported");
    if (input.run_in_background === true)
      unsupportedFeature("background Claude Bash tools are not supported");
    if (
      input.timeout !== undefined &&
      (typeof input.timeout !== "number" ||
        !Number.isSafeInteger(input.timeout) ||
        input.timeout < 1 ||
        input.timeout > 300_000)
    ) {
      unsupportedFeature("Claude Bash timeout is outside the pinned Gateway limit");
    }
  }
}
