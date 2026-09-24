import { isDeepStrictEqual } from "node:util";
import type { ModelEvent, ModelUsage } from "@zcode/contracts";

export interface GatewaySseFrame {
  event?: string;
  data: unknown;
}
export interface GatewayStreamContext {
  requestId: string;
  modelId: string;
  createdAt: number;
  signal?: AbortSignal;
}

type OutputItem = Record<string, unknown>;
interface TextPart {
  id: string;
  index: number;
  text: string;
}
interface ToolPart {
  id: string;
  index: number;
  name: string;
  raw: string;
  closed: boolean;
}

/** Converts one executor stream into a single authoritative Responses snapshot. */
export async function* encodeResponsesStream(
  events: AsyncIterable<ModelEvent>,
  context: GatewayStreamContext,
): AsyncIterable<GatewaySseFrame> {
  const output: OutputItem[] = [];
  const texts = new Map<string, TextPart>();
  const tools = new Map<string, ToolPart>();
  let activeText: string | undefined;
  let finished = false;
  const response = (status: string, extra: Record<string, unknown> = {}) => ({
    id: context.requestId,
    object: "response",
    created_at: context.createdAt,
    model: context.modelId,
    status,
    output: output.map((item) => structuredClone(item)),
    ...extra,
  });
  const frame = (event: string, data: Record<string, unknown>): GatewaySseFrame => ({
    event,
    data: { type: event, ...data },
  });
  yield frame("response.created", { response: response("in_progress") });
  yield frame("response.in_progress", { response: response("in_progress") });
  try {
    if (context.signal?.aborted) throw new Error("cancelled");
    for await (const event of events) {
      if (context.signal?.aborted) throw new Error("cancelled");
      switch (event.type) {
        case "start":
        case "compact_stream_boundary":
          break;
        case "text_start": {
          if (texts.has(event.id)) throw new Error("duplicate text identity");
          const index = output.length;
          const item = {
            id: `${context.requestId}-item-${index}`,
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [] as unknown[],
          };
          output.push(item);
          texts.set(event.id, { id: item.id, index, text: "" });
          activeText = event.id;
          yield frame("response.output_item.added", {
            output_index: index,
            item: structuredClone(item),
          });
          yield frame("response.content_part.added", {
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: { type: "output_text", text: "" },
          });
          break;
        }
        case "text_delta": {
          const openTexts = [...texts.values()].filter(
            (part) => output[part.index]?.status === "in_progress",
          );
          const part = texts.get(event.id ?? (openTexts.length === 1 ? activeText : "") ?? "");
          if (!part || output[part.index]?.status !== "in_progress")
            throw new Error("text delta without unambiguous open text");
          part.text += event.text;
          yield frame("response.output_text.delta", {
            item_id: part.id,
            output_index: part.index,
            content_index: 0,
            delta: event.text,
          });
          break;
        }
        case "text_end": {
          const part = texts.get(event.id);
          if (!part || output[part.index]?.status !== "in_progress")
            throw new Error("text end without open text");
          const item = output[part.index]!;
          const content = { type: "output_text", text: part.text };
          item.content = [content];
          item.status = "completed";
          yield frame("response.output_text.done", {
            item_id: part.id,
            output_index: part.index,
            content_index: 0,
            text: part.text,
          });
          yield frame("response.content_part.done", {
            item_id: part.id,
            output_index: part.index,
            content_index: 0,
            part: content,
          });
          yield frame("response.output_item.done", {
            output_index: part.index,
            item: structuredClone(item),
          });
          break;
        }
        case "tool_input_start": {
          if (event.providerExecuted || tools.has(event.id))
            throw new Error("unsupported or duplicate tool call");
          const index = output.length;
          const item = {
            id: `${context.requestId}-item-${index}`,
            type: "function_call",
            status: "in_progress",
            name: event.toolName,
            call_id: event.id,
            arguments: "",
          };
          output.push(item);
          tools.set(event.id, { id: item.id, index, name: event.toolName, raw: "", closed: false });
          yield frame("response.output_item.added", {
            output_index: index,
            item: structuredClone(item),
          });
          break;
        }
        case "tool_input_delta": {
          const tool = tools.get(event.id);
          if (!tool || tool.closed) throw new Error("tool delta without open call");
          tool.raw += event.delta;
          yield frame("response.function_call_arguments.delta", {
            item_id: tool.id,
            output_index: tool.index,
            delta: event.delta,
          });
          break;
        }
        case "tool_input_end": {
          const tool = tools.get(event.id);
          if (!tool || tool.closed) throw new Error("tool end without open call");
          tool.closed = true;
          break;
        }
        case "tool_call": {
          const { id, name, input, providerExecuted } = event.toolCall;
          if (providerExecuted || !input || typeof input !== "object" || Array.isArray(input))
            throw new Error("unsupported tool call");
          let tool = tools.get(id);
          if (!tool) {
            const index = output.length;
            const item = {
              id: `${context.requestId}-item-${index}`,
              type: "function_call",
              status: "in_progress",
              name,
              call_id: id,
              arguments: "",
            };
            output.push(item);
            tool = { id: item.id, index, name, raw: "", closed: true };
            tools.set(id, tool);
            yield frame("response.output_item.added", {
              output_index: index,
              item: structuredClone(item),
            });
          }
          if (!tool.closed || tool.name !== name || output[tool.index]?.status !== "in_progress")
            throw new Error("tool call identity mismatch");
          let raw = tool.raw;
          if (raw) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              throw new Error("invalid tool JSON");
            }
            if (!isDeepStrictEqual(parsed, input))
              throw new Error("tool JSON disagrees with committed input");
          } else {
            raw = JSON.stringify(input);
            yield frame("response.function_call_arguments.delta", {
              item_id: tool.id,
              output_index: tool.index,
              delta: raw,
            });
          }
          const item = output[tool.index]!;
          item.arguments = raw;
          item.status = "completed";
          yield frame("response.function_call_arguments.done", {
            item_id: tool.id,
            output_index: tool.index,
            arguments: raw,
          });
          yield frame("response.output_item.done", {
            output_index: tool.index,
            item: structuredClone(item),
          });
          break;
        }
        case "finish": {
          if (output.some((item) => item.status !== "completed") || context.signal?.aborted)
            throw new Error("unfinished output");
          if (
            !Number.isFinite(event.usage.inputTokens ?? 0) ||
            !Number.isFinite(event.usage.outputTokens ?? 0)
          )
            throw new Error("invalid usage");
          const usage = mapUsage(event.usage);
          if (event.finishReason === "stop" || event.finishReason === "tool-calls") {
            yield frame("response.completed", { response: response("completed", { usage }) });
          } else if (event.finishReason === "length") {
            yield frame("response.incomplete", {
              response: response("incomplete", {
                usage,
                incomplete_details: { reason: "max_output_tokens" },
              }),
            });
          } else throw new Error("unsupported finish reason");
          finished = true;
          break;
        }
        case "error":
          throw new Error("model executor error");
        default:
          throw new Error("unsupported model event");
      }
      if (finished) break;
    }
    if (!finished) throw new Error("missing finish");
  } catch {
    yield frame("response.failed", {
      response: response("failed", {
        error: {
          code: context.signal?.aborted ? "cancelled" : "model_stream_failed",
          message: "Model response failed",
        },
      }),
    });
  }
}

function mapUsage(usage: ModelUsage): Record<string, unknown> | null {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  const result: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  };
  if (usage.cacheReadTokens !== undefined)
    result.input_tokens_details = { cached_tokens: usage.cacheReadTokens };
  if (usage.reasoningTokens !== undefined)
    result.output_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  return result;
}
