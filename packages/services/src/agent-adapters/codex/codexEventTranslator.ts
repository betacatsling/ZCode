import type { AgentEvent } from "@zcode/shared/agent-host";
import type { CodexActiveTurn, CodexSessionRuntime } from "./codexRuntime.js";

type Emit = (kind: AgentEvent["kind"], fields: Record<string, unknown>) => void;
type Terminal = (turn: CodexActiveTurn, status: string, hasError: boolean) => void;

export function translateCodexNotification(
  runtime: CodexSessionRuntime,
  method: string,
  value: unknown,
  terminal: Terminal,
): void {
  if (!isRecord(value)) return;
  if (method === "error") {
    if (value.threadId !== undefined && value.threadId !== runtime.threadId) return;
    emitSessionError(runtime.emit, "codex-backend-error", "Codex app-server reported an error.");
    return;
  }
  if (method === "turn/started") {
    if (value.threadId !== runtime.threadId || !isRecord(value.turn)) return;
    const backendTurnId = nonEmptyString(value.turn.id);
    const turn = runtime.activeTurn;
    if (!backendTurnId || !turn) return;
    if (turn.backendTurnId && turn.backendTurnId !== backendTurnId) return;
    turn.backendTurnId = backendTurnId;
    emitTurnStarted(runtime.emit, turn);
    return;
  }
  if (method === "turn/completed") {
    if (value.threadId !== runtime.threadId || !isRecord(value.turn)) return;
    const backendTurnId = nonEmptyString(value.turn.id);
    const turn = runtime.activeTurn;
    if (!backendTurnId || !turn) return;
    if (turn.backendTurnId && turn.backendTurnId !== backendTurnId) return;
    turn.backendTurnId = backendTurnId;
    emitTurnStarted(runtime.emit, turn);
    const status = typeof value.turn.status === "string" ? value.turn.status : "unknown";
    const hasError = value.turn.error !== null && value.turn.error !== undefined;
    terminal(turn, status, hasError);
    return;
  }
  if (method === "thread/tokenUsage/updated") {
    translateUsage(runtime, value);
    return;
  }
  const turn = runtime.activeTurn;
  if (!turn || !turn.backendTurnId || value.threadId !== runtime.threadId) return;
  if (typeof value.turnId !== "string" || value.turnId !== turn.backendTurnId) return;
  switch (method) {
    case "item/started":
      if (isRecord(value.item)) translateItemStarted(runtime.emit, runtime, turn, value.item);
      return;
    case "item/completed":
      if (isRecord(value.item)) translateItemCompleted(runtime.emit, runtime, turn, value.item);
      return;
    case "item/agentMessage/delta":
      translateMessageDelta(runtime.emit, runtime, turn, value);
      return;
    default:
      return;
  }
}

export function ensureToolStarted(
  emit: Emit,
  runtime: CodexSessionRuntime,
  turn: CodexActiveTurn,
  itemId: string,
  toolName: "exec_command" | "file_change",
  summary?: string,
): void {
  if (runtime.tools.has(itemId)) return;
  runtime.tools.set(itemId, toolName);
  emit("tool.started", {
    turnId: turn.hostTurnId,
    toolCallId: itemId,
    name: toolName,
    ...(summary ? { inputText: summary.slice(0, 16_000) } : {}),
  });
}

/** Codex item IDs are thread-local; V4 event correlation is scoped to the Host turn. */
export function codexTurnItemId(hostTurnId: string, nativeItemId: string): string {
  return `codex:${hostTurnId}:${nativeItemId}`;
}

export function emitTurnStarted(emit: Emit, turn: CodexActiveTurn): void {
  if (turn.started) return;
  turn.started = true;
  emit("turn.started", { turnId: turn.hostTurnId });
}

function translateItemStarted(
  emit: Emit,
  runtime: CodexSessionRuntime,
  turn: CodexActiveTurn,
  item: Record<string, unknown>,
): void {
  const itemId = nonEmptyString(item.id);
  if (!itemId) return;
  const toolCallId = codexTurnItemId(turn.hostTurnId, itemId);
  if (item.type === "commandExecution") {
    ensureToolStarted(
      emit,
      runtime,
      turn,
      toolCallId,
      "exec_command",
      optionalString(item.command),
    );
  } else if (item.type === "fileChange") {
    ensureToolStarted(
      emit,
      runtime,
      turn,
      toolCallId,
      "file_change",
      "Codex requested a file change.",
    );
  }
}

function translateItemCompleted(
  emit: Emit,
  runtime: CodexSessionRuntime,
  turn: CodexActiveTurn,
  item: Record<string, unknown>,
): void {
  const itemId = nonEmptyString(item.id);
  if (!itemId) return;
  const messageId = codexTurnItemId(turn.hostTurnId, itemId);
  if (item.type === "agentMessage") {
    const text = optionalString(item.text) ?? runtime.messages.get(messageId) ?? "";
    emit("message.finished", {
      turnId: turn.hostTurnId,
      messageId,
      role: "assistant",
      text,
    });
    runtime.messages.delete(messageId);
    return;
  }
  if (item.type === "userMessage") {
    const text = userInputText(item.content);
    if (text !== undefined)
      emit("message.finished", { turnId: turn.hostTurnId, messageId, role: "user", text });
    return;
  }
  if (item.type === "commandExecution") {
    const toolCallId = codexTurnItemId(turn.hostTurnId, itemId);
    const toolName = runtime.tools.get(toolCallId) ?? "exec_command";
    ensureToolStarted(emit, runtime, turn, toolCallId, toolName, optionalString(item.command));
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : undefined;
    const status = optionalString(item.status);
    emit("tool.finished", {
      turnId: turn.hostTurnId,
      toolCallId,
      name: toolName,
      outcome:
        status === "completed" && (exitCode === undefined || exitCode === 0) ? "success" : "error",
      ...(optionalString(item.aggregatedOutput)
        ? { outputText: (item.aggregatedOutput as string).slice(0, 32_000) }
        : {}),
    });
    runtime.tools.delete(toolCallId);
    return;
  }
  if (item.type === "fileChange") {
    const toolCallId = codexTurnItemId(turn.hostTurnId, itemId);
    const toolName = runtime.tools.get(toolCallId) ?? "file_change";
    ensureToolStarted(emit, runtime, turn, toolCallId, toolName, "Codex requested a file change.");
    translateFileChanges(emit, turn, toolCallId, item.changes);
    emit("tool.finished", {
      turnId: turn.hostTurnId,
      toolCallId,
      name: toolName,
      outcome: item.status === "completed" ? "success" : "error",
    });
    runtime.tools.delete(toolCallId);
  }
}

function translateMessageDelta(
  emit: Emit,
  runtime: CodexSessionRuntime,
  turn: CodexActiveTurn,
  value: Record<string, unknown>,
): void {
  const messageId = nonEmptyString(value.itemId);
  const delta = typeof value.delta === "string" ? value.delta : undefined;
  if (!messageId || delta === undefined) return;
  const scopedMessageId = codexTurnItemId(turn.hostTurnId, messageId);
  runtime.messages.set(scopedMessageId, (runtime.messages.get(scopedMessageId) ?? "") + delta);
  emit("text.delta", { turnId: turn.hostTurnId, messageId: scopedMessageId, text: delta });
}

function translateUsage(runtime: CodexSessionRuntime, value: Record<string, unknown>): void {
  const turn = runtime.activeTurn;
  if (
    !turn ||
    value.threadId !== runtime.threadId ||
    value.turnId !== turn.backendTurnId ||
    !isRecord(value.tokenUsage) ||
    !isRecord(value.tokenUsage.last)
  )
    return;
  const inputTokens = safeCount(value.tokenUsage.last.inputTokens);
  const outputTokens = safeCount(value.tokenUsage.last.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return;
  runtime.emit("usage.reported", { turnId: turn.hostTurnId, inputTokens, outputTokens });
}

function translateFileChanges(
  emit: Emit,
  turn: CodexActiveTurn,
  itemId: string,
  value: unknown,
): void {
  if (!Array.isArray(value)) return;
  for (const change of value) {
    if (!isRecord(change) || typeof change.path !== "string") continue;
    const diff = typeof change.diff === "string" ? change.diff.split("\n") : [];
    const additions = diff.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = diff.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    emit("file.changed", {
      turnId: turn.hostTurnId,
      toolCallId: itemId,
      name: "file_change",
      path: change.path,
      additions,
      deletions,
    });
  }
}

function userInputText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) =>
    isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  );
  return parts.length ? parts.join("\n") : undefined;
}

function emitSessionError(emit: Emit, code: string, message: string): void {
  emit("session.error", { code, message });
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
