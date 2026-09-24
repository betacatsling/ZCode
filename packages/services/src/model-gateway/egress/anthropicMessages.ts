import { isDeepStrictEqual } from "node:util";
import type { ModelEvent } from "@zcode/contracts";

type Context = { requestId: string; modelId: string; createdAt: number; signal?: AbortSignal };
type Frame = { event?: string; data: unknown };
type OpenText = { index: number; closed: boolean };
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
          if (texts.has(event.id) || tools.has(event.id)) fail("duplicate_block_id");
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
          if (texts.has(event.id) || tools.has(event.id) || event.providerExecuted)
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
        case "finish": {
          if (tools.size || [...texts.values()].some((text) => !text.closed))
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
            cacheReadTokens ||
            cacheWriteTokens ||
            reasoningTokens ||
            serverToolUse
          )
            fail("unsupported_usage");
          checkAbort();
          terminal = frame("message_delta", {
            delta: { stop_reason: reason, stop_sequence: null },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          finished = true;
          break;
        }
        case "error":
          fail("executor_error");
        case "reasoning_start":
        case "reasoning_delta":
        case "reasoning_end":
          fail("unsupported_reasoning");
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
