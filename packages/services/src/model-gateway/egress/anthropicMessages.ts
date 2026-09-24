import { isDeepStrictEqual } from "node:util";
import type { ModelEvent } from "@zcode/contracts";

type Context = { requestId: string; modelId: string; createdAt: number; signal?: AbortSignal };
type Frame = { event?: string; data: unknown };
type OpenText = { index: number; closed: boolean };
type OpenReasoning = { index: number; signature?: string; closed: boolean };
type OpenTool = { index: number; name: string; json: string; ended: boolean };
const frame = (event: string, data: Record<string, unknown>): Frame => ({
  event,
  data: { type: event, ...data },
});

/** Only completed, agreed-upon tool JSON may close a tool block successfully. */
export async function* encodeAnthropicMessagesStream(
  events: AsyncIterable<ModelEvent>,
  context: Context,
): AsyncIterable<Frame> {
  let started = false;
  let finished = false;
  let terminal: Frame | undefined;
  let index = 0;
  let completedTools = 0;
  const texts = new Map<string, OpenText>();
  const tools = new Map<string, OpenTool>();
  const reasoning = new Map<string, OpenReasoning>();
  const signature = (metadata: Record<string, unknown> | undefined): string | undefined => {
    if (metadata === undefined) return undefined;
    if (Object.keys(metadata).length !== 1 || typeof metadata.anthropic !== "object" || !metadata.anthropic || Array.isArray(metadata.anthropic)) fail("unsupported_reasoning_metadata");
    const value = metadata.anthropic as Record<string, unknown>;
    if (Object.keys(value).length !== 1 || typeof value.signature !== "string" || !value.signature) fail("unsupported_reasoning_metadata");
    return value.signature as string;
  };
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const checkAbort = () => {
    if (context.signal?.aborted) fail("cancelled");
  };
  const start = (): Frame => {
    started = true;
    return frame("message_start", {
      message: {
        id: context.requestId,
        type: "message",
        role: "assistant",
        model: context.modelId,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  try {
    for await (const event of events) {
      checkAbort();
      if (finished) fail("event_after_finish");
      if (!started) yield start();
      switch (event.type) {
        case "start":
          break;
        case "text_start": {
          if (texts.has(event.id) || tools.has(event.id) || reasoning.has(event.id)) fail("duplicate_block_id");
          const blockIndex = index++;
          texts.set(event.id, { index: blockIndex, closed: false });
          yield frame("content_block_start", {
            index: blockIndex,
            content_block: { type: "text", text: "" },
          });
          break;
        }
        case "text_delta": {
          const openIds = [...texts].filter(([, value]) => !value.closed).map(([id]) => id);
          if (!event.id && openIds.length !== 1) fail("ambiguous_text_delta");
          const text = texts.get(event.id ?? openIds[0]!);
          if (!text || text.closed) throw new Error("text_delta_without_start");
          yield frame("content_block_delta", {
            index: text.index,
            delta: { type: "text_delta", text: event.text },
          });
          break;
        }
        case "text_end": {
          const text = texts.get(event.id);
          if (!text || text.closed) throw new Error("text_end_without_start");
          text.closed = true;
          yield frame("content_block_stop", { index: text.index });
          break;
        }
        case "tool_input_start": {
          if (texts.has(event.id) || tools.has(event.id) || reasoning.has(event.id) || event.providerExecuted)
            fail("unsupported_tool_start");
          const blockIndex = index++;
          tools.set(event.id, { index: blockIndex, name: event.toolName, json: "", ended: false });
          yield frame("content_block_start", {
            index: blockIndex,
            content_block: { type: "tool_use", id: event.id, name: event.toolName, input: {} },
          });
          break;
        }
        case "tool_input_delta": {
          const tool = tools.get(event.id);
          if (!tool || tool.ended) throw new Error("tool_delta_without_start");
          tool.json += event.delta;
          yield frame("content_block_delta", {
            index: tool.index,
            delta: { type: "input_json_delta", partial_json: event.delta },
          });
          break;
        }
        case "tool_input_end": {
          const tool = tools.get(event.id);
          if (!tool || tool.ended) throw new Error("tool_end_without_start");
          tool.ended = true;
          break;
        }
        case "tool_call": {
          const { id, name, input, providerExecuted } = event.toolCall;
          const tool = tools.get(id);
          if (
            !tool ||
            !tool.ended ||
            tool.name !== name ||
            providerExecuted ||
            !input ||
            typeof input !== "object" ||
            Array.isArray(input)
          )
            throw new Error("invalid_tool_commit");
          let parsed: unknown;
          try {
            parsed = JSON.parse(tool.json || JSON.stringify(input));
          } catch {
            fail("invalid_tool_json");
          }
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !isDeepStrictEqual(parsed, input)
          )
            fail("tool_json_mismatch");
          if (!tool.json)
            yield frame("content_block_delta", {
              index: tool.index,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
            });
          tools.delete(id);
          completedTools++;
          yield frame("content_block_stop", { index: tool.index });
          break;
        }
        case "reasoning_start": {
          if (texts.has(event.id) || tools.has(event.id) || reasoning.has(event.id)) fail("duplicate_block_id");
          const blockIndex = index++;
          reasoning.set(event.id, { index: blockIndex, signature: signature(event.providerMetadata), closed: false });
          yield frame("content_block_start", { index: blockIndex, content_block: { type: "thinking", thinking: "" } });
          break;
        }
        case "reasoning_delta": {
          const open = [...reasoning].filter(([, value]) => !value.closed).map(([id]) => id);
          if (!event.id && open.length !== 1) fail("ambiguous_reasoning_delta");
          const block = reasoning.get(event.id ?? open[0]!);
          if (!block || block.closed) throw new Error("reasoning_delta_without_start");
          const original = signature(event.providerMetadata);
          if (original) {
            if (block.signature && block.signature !== original) fail("reasoning_signature_mismatch");
            block.signature = original;
          }
          if (event.text) yield frame("content_block_delta", { index: block.index, delta: { type: "thinking_delta", thinking: event.text } });
          break;
        }
        case "reasoning_end": {
          const block = reasoning.get(event.id);
          if (!block || block.closed) throw new Error("reasoning_end_without_start");
          const original = signature(event.providerMetadata);
          if (original) {
            if (block.signature && block.signature !== original) fail("reasoning_signature_mismatch");
            block.signature = original;
          }
          if (!block.signature) fail("unsigned_reasoning");
          yield frame("content_block_delta", { index: block.index, delta: { type: "signature_delta", signature: block.signature } });
          block.closed = true;
          yield frame("content_block_stop", { index: block.index });
          break;
        }
        case "finish": {
          if (tools.size || [...texts.values()].some((text) => !text.closed) || [...reasoning.values()].some((block) => !block.closed))
            fail("unfinished_content_block");
          const reason =
            event.finishReason === "stop"
              ? "end_turn"
              : event.finishReason === "length"
                ? "max_tokens"
                : event.finishReason === "tool-calls"
                  ? "tool_use"
                  : undefined;
          if (
            !reason ||
            (reason === "tool_use" && !completedTools) ||
            (completedTools && reason !== "tool_use") ||
            (event.providerMetadata && Object.keys(event.providerMetadata).length)
          )
            fail("unsupported_finish_reason");
          const {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens,
            serverToolUse,
          } = event.usage;
          if (
            !Number.isSafeInteger(inputTokens) ||
            (inputTokens as number) < 0 ||
            !Number.isSafeInteger(outputTokens) ||
            (outputTokens as number) < 0 ||
            (cacheReadTokens !== undefined && (!Number.isSafeInteger(cacheReadTokens) || cacheReadTokens < 0)) ||
            (cacheWriteTokens !== undefined && (!Number.isSafeInteger(cacheWriteTokens) || cacheWriteTokens < 0)) ||
            (reasoningTokens !== undefined && (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0)) ||
            serverToolUse ||
            (inputTokens as number) < (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
          )
            fail("unsupported_usage");
          checkAbort();
          // 修复原因：AI SDK 的 inputTokens 已含缓存命中/写入；Messages 的 input_tokens 只计未缓存部分。
          terminal = frame("message_delta", {
            delta: { stop_reason: reason, stop_sequence: null },
            usage: {
              input_tokens: (inputTokens as number) - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0),
              output_tokens: outputTokens,
              ...(cacheReadTokens !== undefined ? { cache_read_input_tokens: cacheReadTokens } : {}),
              ...(cacheWriteTokens !== undefined ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
            },
          });
          finished = true;
          break;
        }
        case "error":
          fail("executor_error");
        case "compact_stream_boundary":
          break;
      }
    }
    checkAbort();
    if (!finished || !terminal) throw new Error("missing_finish");
    yield terminal;
    checkAbort();
    yield frame("message_stop", {});
  } catch {
    yield frame("error", {
      error: {
        type: context.signal?.aborted ? "request_cancelled" : "api_error",
        message: context.signal?.aborted
          ? "Request cancelled"
          : "Model stream could not be completed",
      },
    });
  }
}
