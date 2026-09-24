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
interface ReasoningPart {
  id: string;
  index: number;
  text: string;
  encrypted?: string;
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
  const reasoning = new Map<string, ReasoningPart>();
  const originalReasoning = (metadata: Record<string, unknown> | undefined): { itemId?: string; encrypted?: string } => {
    if (metadata === undefined) return {};
    if (Object.keys(metadata).length !== 1 || typeof metadata.openai !== "object" || !metadata.openai || Array.isArray(metadata.openai)) throw new Error("unsupported reasoning metadata");
    const value = metadata.openai as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== "itemId" && key !== "reasoningEncryptedContent") ||
      (value.itemId !== undefined && (typeof value.itemId !== "string" || !value.itemId)) ||
      (value.reasoningEncryptedContent != null && (typeof value.reasoningEncryptedContent !== "string" || !value.reasoningEncryptedContent)) ||
      (value.reasoningEncryptedContent && !value.itemId)) throw new Error("invalid reasoning metadata");
    return { itemId: value.itemId as string | undefined, encrypted: (value.reasoningEncryptedContent ?? undefined) as string | undefined };
  };
  let activeText: string | undefined;
  let finished = false;
  let terminal: GatewaySseFrame | undefined;
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
      if (finished) throw new Error("event after finish");
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
        case "reasoning_start": {
          if (reasoning.has(event.id) || texts.has(event.id) || tools.has(event.id)) throw new Error("duplicate reasoning identity");
          const original = originalReasoning(event.providerMetadata);
          const index = output.length;
          const id = original.itemId ?? `${context.requestId}-item-${index}`;
          if (output.some((item) => item.id === id)) throw new Error("duplicate response identity");
          const item = { id, type: "reasoning", status: "in_progress", summary: [] as unknown[], ...(original.encrypted ? { encrypted_content: original.encrypted } : {}) };
          output.push(item);
          reasoning.set(event.id, { id, index, text: "", encrypted: original.encrypted });
          yield frame("response.output_item.added", { output_index: index, item: structuredClone(item) });
          yield frame("response.reasoning_summary_part.added", { item_id: id, output_index: index, summary_index: 0, part: { type: "summary_text", text: "" } });
          break;
        }
        case "reasoning_delta": {
          const open = [...reasoning].filter(([, part]) => output[part.index]?.status === "in_progress");
          const part = reasoning.get(event.id ?? (open.length === 1 ? open[0]![0] : ""));
          if (!part || output[part.index]?.status !== "in_progress") throw new Error("reasoning delta without unambiguous start");
          const original = originalReasoning(event.providerMetadata);
          if ((original.itemId && original.itemId !== part.id) || (original.encrypted && original.encrypted !== part.encrypted)) throw new Error("reasoning identity mismatch");
          part.text += event.text;
          if (event.text) yield frame("response.reasoning_summary_text.delta", { item_id: part.id, output_index: part.index, summary_index: 0, delta: event.text });
          break;
        }
        case "reasoning_end": {
          const part = reasoning.get(event.id);
          if (!part || output[part.index]?.status !== "in_progress") throw new Error("reasoning end without start");
          const original = originalReasoning(event.providerMetadata);
          if ((original.itemId && original.itemId !== part.id) || (original.encrypted && original.encrypted !== part.encrypted)) throw new Error("reasoning identity mismatch");
          const item = output[part.index]!;
          const summary = { type: "summary_text", text: part.text };
          item.summary = [summary];
          item.status = "completed";
          yield frame("response.reasoning_summary_part.done", { item_id: part.id, output_index: part.index, summary_index: 0, part: summary });
          yield frame("response.output_item.done", { output_index: part.index, item: structuredClone(item) });
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
          const usage = mapUsage(event.usage);
          if (event.finishReason === "stop" || event.finishReason === "tool-calls") {
            terminal = frame("response.completed", { response: response("completed", { usage }) });
          } else if (event.finishReason === "length") {
            terminal = frame("response.incomplete", {
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
    }
    if (!finished || !terminal || context.signal?.aborted) throw new Error("missing finish");
    // 修复原因：finish 后异步流仍可能出错；必须等迭代完成，不能先发成功终态。
    yield terminal;
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
  const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return null;
  if ([inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens]
    .some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
    (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) > inputTokens ||
    (totalTokens !== undefined && totalTokens !== inputTokens + outputTokens) || usage.serverToolUse)
    throw new Error("invalid usage");
  const result: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: totalTokens ?? inputTokens + outputTokens,
  };
  if (usage.cacheReadTokens !== undefined)
    result.input_tokens_details = { cached_tokens: usage.cacheReadTokens };
  if (usage.reasoningTokens !== undefined)
    result.output_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  return result;
}
