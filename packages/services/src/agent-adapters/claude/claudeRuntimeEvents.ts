import type { AgentEvent } from "@zcode/shared/agent-host";
import type {
  ClaudeActiveTurn,
  ClaudeSessionRuntime,
  ClaudeToolCallRecord,
} from "./claudeRuntime.js";
import { claudeTurnMessageId, claudeTurnToolId } from "./claudeRuntime.js";
import type { ClaudeStructuredMessage } from "./claudeStreamProcess.js";

type RecordValue = Record<string, unknown>;

export function translateClaudeStructuredMessage(
  runtime: ClaudeSessionRuntime,
  message: ClaudeStructuredMessage,
  terminal: (runtime: ClaudeSessionRuntime, turn: ClaudeActiveTurn, result: RecordValue) => void,
  failed: (runtime: ClaudeSessionRuntime, message: string) => void,
): void {
  if (runtime.stopping) return;
  if (message.type === "system") {
    translateSystem(runtime, message, failed);
    return;
  }
  if (message.type === "stream_event") {
    translateStreamEvent(runtime, message.event, failed);
    return;
  }
  if (message.type === "assistant") {
    translateAssistant(runtime, message, failed);
    return;
  }
  if (message.type === "user") {
    translateUser(runtime, message);
    return;
  }
  if (message.type === "result") {
    if (!isRecord(message)) return failed(runtime, "Claude result message is invalid");
    if (message.session_id !== runtime.binding.backendSessionId)
      return failed(runtime, "Claude result belongs to another native session");
    const turn = runtime.activeTurn;
    if (turn) terminal(runtime, turn, message);
    return;
  }
  if (["hook_started", "hook_progress", "hook_response", "tool_progress"].includes(message.type))
    return;
  failed(runtime, "Claude Code emitted an unsupported structured stream event");
}

function translateSystem(
  runtime: ClaudeSessionRuntime,
  message: RecordValue,
  failed: (runtime: ClaudeSessionRuntime, message: string) => void,
): void {
  if (message.subtype === "init") {
    if (message.session_id !== runtime.binding.backendSessionId) {
      failed(runtime, "Claude native session ID differs from the Host binding");
      return;
    }
    runtime.initialized = true;
    return;
  }
  if (message.subtype === "status") return;
  // Claude Code 2.1.x emits additional informational system subtypes during tool rounds
  // (hooks/progress/tasks). Init is enforced above; ignore the rest so PreToolUse can proceed.
  if (typeof message.subtype === "string") return;
  failed(
    runtime,
    `Claude Code emitted an unsupported system event (${JSON.stringify(message.subtype)})`,
  );
}

function translateStreamEvent(
  runtime: ClaudeSessionRuntime,
  value: unknown,
  failed: (runtime: ClaudeSessionRuntime, message: string) => void,
): void {
  const event = asRecord(value);
  const turn = runtime.activeTurn;
  if (!event || !turn) return failed(runtime, "Claude streamed output outside an active Host turn");
  if (event.type === "ping" || event.type === "message_delta" || event.type === "message_stop")
    return;
  if (event.type === "message_start") {
    const message = asRecord(event.message);
    if (!message || !nonEmptyString(message.id))
      return failed(runtime, "Claude message_start is invalid");
    runtime.activeNativeMessageId = message.id;
    ensureTurnStarted(runtime, turn);
    return;
  }
  if (event.type === "content_block_start") {
    const block = asRecord(event.content_block);
    const index = safeIndex(event.index);
    if (!block || index === undefined)
      return failed(runtime, "Claude content_block_start is invalid");
    if (block.type === "text") return;
    if (block.type !== "tool_use" || !nonEmptyString(block.id) || !nonEmptyString(block.name))
      return failed(runtime, "Claude emitted an unsupported content block");
    const record = upsertToolCall(runtime, turn, block.id, block.name, undefined);
    runtime.toolBlocks.set(`${turn.hostTurnId}:${index}`, record);
    return;
  }
  if (event.type === "content_block_delta") {
    const delta = asRecord(event.delta);
    const index = safeIndex(event.index);
    if (!delta || index === undefined)
      return failed(runtime, "Claude content_block_delta is invalid");
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const messageId = messageIdForEvent(runtime, event);
      if (!messageId) return failed(runtime, "Claude text delta has no message owner");
      ensureTurnStarted(runtime, turn);
      runtime.emit("text.delta", {
        turnId: turn.hostTurnId,
        messageId,
        text: delta.text,
      });
      return;
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const tool = runtime.toolBlocks.get(`${turn.hostTurnId}:${index}`);
      if (!tool) return failed(runtime, "Claude tool input delta has no tool_use owner");
      tool.inputText += delta.partial_json;
      tool.input = parseObjectJson(tool.inputText);
      return;
    }
    return failed(runtime, "Claude emitted an unsupported content delta");
  }
  if (event.type === "content_block_stop") {
    const index = safeIndex(event.index);
    if (index === undefined) return failed(runtime, "Claude content_block_stop is invalid");
    const tool = runtime.toolBlocks.get(`${turn.hostTurnId}:${index}`);
    if (tool) {
      tool.input = parseObjectJson(tool.inputText || "{}");
      if (!tool.input) return failed(runtime, "Claude tool arguments are incomplete");
    }
    return;
  }
  failed(runtime, "Claude Messages stream event is not supported by the pinned adapter");
}

function translateAssistant(
  runtime: ClaudeSessionRuntime,
  message: RecordValue,
  failed: (runtime: ClaudeSessionRuntime, message: string) => void,
): void {
  const turn = runtime.activeTurn;
  if (!turn)
    return failed(runtime, "Claude emitted an assistant message outside an active Host turn");
  if (message.session_id !== runtime.binding.backendSessionId) {
    failed(runtime, "Claude assistant message belongs to another native session");
    return;
  }
  const body = asRecord(message.message);
  if (!body || !nonEmptyString(body.id) || !Array.isArray(body.content)) {
    failed(runtime, "Claude assistant message is invalid");
    return;
  }
  ensureTurnStarted(runtime, turn);
  let text = "";
  for (const value of body.content) {
    const block = asRecord(value);
    if (!block) return failed(runtime, "Claude assistant content block is invalid");
    if (block.type === "text") {
      if (typeof block.text !== "string")
        return failed(runtime, "Claude assistant text is invalid");
      text += block.text;
    } else if (block.type === "tool_use") {
      if (!nonEmptyString(block.id) || !nonEmptyString(block.name))
        return failed(runtime, "Claude tool_use block is invalid");
      upsertToolCall(runtime, turn, block.id, block.name, block.input);
    } else {
      return failed(runtime, "Claude assistant emitted an unsupported content block");
    }
  }
  if (text) {
    runtime.emit("message.finished", {
      turnId: turn.hostTurnId,
      messageId: claudeTurnMessageId(runtime, turn.hostTurnId, body.id),
      role: "assistant",
      text,
    });
  }
}

function translateUser(runtime: ClaudeSessionRuntime, message: RecordValue): void {
  const turn = runtime.activeTurn;
  const body = asRecord(message.message);
  if (!turn || !body || body.role !== "user") return;
  if (message.session_id !== undefined && message.session_id !== runtime.binding.backendSessionId)
    return;
  const blocks = Array.isArray(body.content)
    ? body.content.map(asRecord).filter((block): block is RecordValue => block !== undefined)
    : typeof body.content === "string"
      ? [{ type: "text", text: body.content }]
      : [];
  const visibleText = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  if (visibleText && blocks.some((block) => block.type === "tool_result")) {
    const userMessageId = nonEmptyString(body.id)
      ? claudeTurnMessageId(runtime, turn.hostTurnId, body.id)
      : claudeTurnMessageId(runtime, turn.hostTurnId, `user-${turn.hostTurnId}`);
    runtime.emit("message.finished", {
      turnId: turn.hostTurnId,
      messageId: userMessageId,
      role: "user",
      text: visibleText,
    });
  }
  for (const block of blocks) {
    if (block.type !== "tool_result" || !nonEmptyString(block.tool_use_id)) continue;
    const tool = runtime.toolCalls.get(block.tool_use_id);
    if (!tool || tool.finished) continue;
    const text = toolResultText(block.content);
    runtime.emit("tool.finished", {
      turnId: turn.hostTurnId,
      toolCallId: tool.hostToolCallId,
      name: tool.name,
      outcome: block.is_error === true ? "error" : "success",
      ...(text ? { outputText: text.slice(0, 32_000) } : {}),
    });
    tool.finished = true;
  }
}

export function upsertToolCall(
  runtime: ClaudeSessionRuntime,
  turn: ClaudeActiveTurn,
  nativeToolUseId: string,
  name: string,
  input: unknown,
): ClaudeToolCallRecord {
  const existing = runtime.toolCalls.get(nativeToolUseId);
  if (existing) {
    if (existing.name !== name) throw new Error("Claude reused a tool ID with another name");
    if (isRecord(input)) existing.input = input;
    return existing;
  }
  if (turn.seenToolIds.has(nativeToolUseId)) throw new Error("Claude repeated a Host-turn tool ID");
  turn.seenToolIds.add(nativeToolUseId);
  const record: ClaudeToolCallRecord = {
    nativeToolUseId,
    hostToolCallId: claudeTurnToolId(runtime, turn.hostTurnId, nativeToolUseId),
    name,
    inputText: isRecord(input) ? JSON.stringify(input) : "",
    ...(isRecord(input) ? { input } : {}),
    finished: false,
  };
  runtime.toolCalls.set(nativeToolUseId, record);
  runtime.emit("tool.started", {
    turnId: turn.hostTurnId,
    toolCallId: record.hostToolCallId,
    name,
    inputText: record.inputText.slice(0, 16_000),
  });
  return record;
}

function ensureTurnStarted(runtime: ClaudeSessionRuntime, turn: ClaudeActiveTurn): void {
  if (turn.started) return;
  turn.started = true;
  runtime.emit("turn.started", { turnId: turn.hostTurnId });
}

function messageIdForEvent(runtime: ClaudeSessionRuntime, _event: RecordValue): string | undefined {
  const turn = runtime.activeTurn;
  if (!turn || !runtime.activeNativeMessageId) return undefined;
  // Structured stream deltas do not repeat message.id; one provider message can contain multiple blocks.
  return claudeTurnMessageId(runtime, turn.hostTurnId, runtime.activeNativeMessageId);
}

function parseObjectJson(text: string): RecordValue | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function toolResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(asRecord)
    .filter((block): block is RecordValue => block !== undefined && block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function safeIndex(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function isRecord(value: unknown): value is RecordValue {
  return asRecord(value) !== undefined;
}
