import type { ModelStreamEvent, ModelUsage } from "@zcode/contracts";
import type { ModelGatewayErrorCode } from "../contract.js";
import { invalidRequest, unsupportedFeature } from "./errors.js";
import {
  canonicalJson,
  parseToolArguments,
  responseUsage,
  type FunctionOutputItem,
  type MessageOutputItem,
  type OutputItem,
  type ResponsesEvent,
  type TextState,
  type ToolState,
} from "./responsesStreamPrimitives.js";

export interface ResponsesStreamEncoderOptions {
  readonly responseId: string;
  readonly model: string;
  readonly allowedTools: ReadonlySet<string>;
  readonly parallelToolCalls: boolean;
  readonly createdAt: number;
  readonly maxToolArgumentBytes?: number;
  readonly instructions?: string;
  readonly maxOutputTokens?: number;
}

export class ResponsesStreamEncoder {
  private readonly output: OutputItem[] = [];
  private readonly tools = new Map<string, ToolState>();
  private nextOutputIndex = 0;
  private activeText: TextState | undefined;
  private started = false;
  private finished = false;
  private nextSequenceNumber = 0;

  constructor(private readonly options: ResponsesStreamEncoderOptions) {}

  start(): ResponsesEvent[] {
    if (this.started) invalidRequest("response stream already started");
    this.started = true;
    const response = this.response("in_progress");
    return this.sequence([
      { type: "response.created", response },
      { type: "response.in_progress", response },
    ]);
  }

  push(event: ModelStreamEvent): ResponsesEvent[] {
    if (!this.started || this.finished) invalidRequest("model stream is not accepting events");
    switch (event.type) {
      case "start":
        return [];
      case "text_start":
        return this.sequence(this.startText(event.id));
      case "text_delta":
        return this.sequence(this.textDelta(event.id, event.text));
      case "text_end":
        return this.sequence(this.endText(event.id));
      case "tool_input_start":
        return this.sequence(this.startTool(event.id, event.toolName, event.providerExecuted));
      case "tool_input_delta":
        return this.sequence(this.toolDelta(event.id, event.delta));
      case "tool_input_end":
        return this.sequence(this.endToolArguments(event.id));
      case "tool_call":
        return this.sequence(this.finishToolCall(event.toolCall));
      case "finish":
        return invalidRequest("finish must be passed to finish()");
      case "error":
        return unsupportedFeature("bound model returned a stream error");
      case "reasoning_start":
      case "reasoning_delta":
      case "reasoning_end":
        return unsupportedFeature("private reasoning output is not supported");
      case "compact_stream_boundary":
        return unsupportedFeature("provider-private stream metadata is not supported");
      default:
        return unsupportedFeature("model stream event is not supported");
    }
  }

  finish(event: Extract<ModelStreamEvent, { type: "finish" }>): ResponsesEvent[] {
    if (!this.started || this.finished) invalidRequest("response stream is not finishable");
    if (this.activeText) invalidRequest("model stream ended with unfinished text");
    if ([...this.tools.values()].some((tool) => !tool.finalized))
      invalidRequest("model stream ended with unfinished tool input");
    if (
      !(
        event.finishReason === "stop" ||
        event.finishReason === "length" ||
        event.finishReason === "tool-calls"
      )
    ) {
      unsupportedFeature("model finish reason is not supported");
    }
    this.finished = true;
    const status = event.finishReason === "length" ? "incomplete" : "completed";
    const response = this.response(status, event.usage);
    if (event.finishReason === "length")
      response.incomplete_details = { reason: "max_output_tokens" };
    return this.sequence([
      { type: status === "completed" ? "response.completed" : "response.incomplete", response },
    ]);
  }

  error(code: ModelGatewayErrorCode, message: string): ResponsesEvent[] {
    if (!this.started || this.finished) invalidRequest("response stream is not accepting errors");
    this.finished = true;
    return this.sequence([
      {
        type: "error",
        error: {
          type: code === "invalid_request" ? "invalid_request_error" : "server_error",
          code,
          message,
          param: null,
        },
      },
    ]);
  }

  private response(
    status: "in_progress" | "completed" | "incomplete",
    usage?: ModelUsage,
  ): Record<string, unknown> {
    const response: Record<string, unknown> = {
      id: this.options.responseId,
      object: "response",
      created_at: this.options.createdAt,
      status,
      error: null,
      incomplete_details: null,
      instructions: this.options.instructions ?? null,
      max_output_tokens: this.options.maxOutputTokens ?? null,
      model: this.options.model,
      output: this.output,
      parallel_tool_calls: this.options.parallelToolCalls,
      previous_response_id: null,
      reasoning: { effort: "none", summary: null },
      store: false,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      top_p: null,
      truncation: "disabled",
      usage: null,
      metadata: {},
    };
    if (usage) {
      const encoded = responseUsage(usage);
      response.usage = encoded ?? null;
    }
    return response;
  }

  private startText(modelId: string): ResponsesEvent[] {
    if (this.activeText) invalidRequest("nested model text blocks are not supported");
    const index = this.nextOutputIndex++;
    const item: MessageOutputItem = {
      id: "msg_" + this.options.responseId + "_" + index,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    };
    this.output.push(item);
    this.activeText = { modelId, index, item, text: "" };
    return [
      {
        type: "response.output_item.added",
        response_id: this.options.responseId,
        output_index: index,
        item,
      },
      {
        type: "response.content_part.added",
        response_id: this.options.responseId,
        item_id: item.id,
        output_index: index,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    ];
  }

  private textDelta(modelId: string | undefined, delta: string): ResponsesEvent[] {
    if (!this.activeText) return invalidRequest("text delta arrived before text_start");
    if (modelId !== undefined && modelId !== this.activeText.modelId)
      invalidRequest("text delta id changed within a block");
    this.activeText.text += delta;
    return [
      {
        type: "response.output_text.delta",
        response_id: this.options.responseId,
        item_id: this.activeText.item.id,
        output_index: this.activeText.index,
        content_index: 0,
        delta,
      },
    ];
  }

  private endText(modelId: string): ResponsesEvent[] {
    const state = this.activeText;
    if (!state || state.modelId !== modelId)
      invalidRequest("text_end does not match an active text block");
    state.item.status = "completed";
    state.item.content.push({ type: "output_text", text: state.text, annotations: [] });
    this.activeText = undefined;
    return [
      {
        type: "response.output_text.done",
        response_id: this.options.responseId,
        item_id: state.item.id,
        output_index: state.index,
        content_index: 0,
        text: state.text,
      },
      {
        type: "response.content_part.done",
        response_id: this.options.responseId,
        item_id: state.item.id,
        output_index: state.index,
        content_index: 0,
        part: state.item.content[0],
      },
      {
        type: "response.output_item.done",
        response_id: this.options.responseId,
        output_index: state.index,
        item: state.item,
      },
    ];
  }

  private startTool(callId: string, name: string, providerExecuted?: boolean): ResponsesEvent[] {
    if (providerExecuted) unsupportedFeature("provider-executed tool calls are not supported");
    if (!callId || this.tools.has(callId))
      invalidRequest("tool call id must be non-empty and unique");
    this.validateToolName(name);
    if (!this.options.parallelToolCalls && this.tools.size > 0)
      unsupportedFeature("multiple tool calls are disabled for this response");
    const index = this.nextOutputIndex++;
    const item: FunctionOutputItem = {
      id: "fcitem_" + this.options.responseId + "_" + index,
      type: "function_call",
      status: "in_progress",
      call_id: callId,
      name,
      arguments: "",
    };
    const state: ToolState = {
      callId,
      index,
      item,
      arguments: "",
      argumentsDone: false,
      finalized: false,
    };
    this.tools.set(callId, state);
    this.output.push(item);
    return [
      {
        type: "response.output_item.added",
        response_id: this.options.responseId,
        output_index: index,
        item,
      },
    ];
  }

  private toolDelta(callId: string, delta: string): ResponsesEvent[] {
    const state = this.tools.get(callId);
    if (!state || state.argumentsDone || state.finalized)
      invalidRequest("tool argument delta has no active call");
    state.arguments += delta;
    state.item.arguments = state.arguments;
    if (
      Buffer.byteLength(state.arguments, "utf8") > (this.options.maxToolArgumentBytes ?? 1_000_000)
    ) {
      unsupportedFeature("tool arguments exceed the configured response bound");
    }
    return [
      {
        type: "response.function_call_arguments.delta",
        response_id: this.options.responseId,
        item_id: state.item.id,
        output_index: state.index,
        delta,
      },
    ];
  }

  private endToolArguments(callId: string): ResponsesEvent[] {
    const state = this.tools.get(callId);
    if (!state || state.argumentsDone || state.finalized)
      invalidRequest("tool_input_end has no active call");
    state.parsedArguments = parseToolArguments(state.arguments);
    state.argumentsDone = true;
    return [
      {
        type: "response.function_call_arguments.done",
        response_id: this.options.responseId,
        item_id: state.item.id,
        output_index: state.index,
        arguments: state.arguments,
      },
    ];
  }

  private finishToolCall(call: {
    id: string;
    name: string;
    input: unknown;
    providerExecuted?: boolean;
  }): ResponsesEvent[] {
    if (call.providerExecuted) unsupportedFeature("provider-executed tool calls are not supported");
    const state = this.tools.get(call.id);
    if (!state) {
      const start = this.startTool(call.id, call.name, call.providerExecuted);
      const args = canonicalJson(call.input);
      const active = this.tools.get(call.id)!;
      active.arguments = args;
      active.item.arguments = args;
      active.parsedArguments = parseToolArguments(args);
      active.argumentsDone = true;
      active.finalized = true;
      active.item.status = "completed";
      return [
        ...start,
        {
          type: "response.function_call_arguments.delta",
          response_id: this.options.responseId,
          item_id: active.item.id,
          output_index: active.index,
          delta: args,
        },
        {
          type: "response.function_call_arguments.done",
          response_id: this.options.responseId,
          item_id: active.item.id,
          output_index: active.index,
          arguments: args,
        },
        {
          type: "response.output_item.done",
          response_id: this.options.responseId,
          output_index: active.index,
          item: active.item,
        },
      ];
    }
    if (state.finalized || !state.argumentsDone || state.item.name !== call.name)
      invalidRequest("final tool call does not match its streamed arguments");
    if (canonicalJson(state.parsedArguments) !== canonicalJson(call.input))
      invalidRequest("final tool call input does not match its streamed arguments");
    state.finalized = true;
    state.item.status = "completed";
    return [
      {
        type: "response.output_item.done",
        response_id: this.options.responseId,
        output_index: state.index,
        item: state.item,
      },
    ];
  }

  private validateToolName(name: string): void {
    if (!name || !this.options.allowedTools.has(name))
      unsupportedFeature("model called a tool not declared by Codex");
  }

  private sequence(events: ResponsesEvent[]): ResponsesEvent[] {
    return events.map((event) => ({ ...event, sequence_number: this.nextSequenceNumber++ }));
  }
}
