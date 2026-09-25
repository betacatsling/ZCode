import type { CodexNativeEvent } from "./codexTransport.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Projects only pinned native notifications with a verified thread/turn; no code executes from backend payloads. */
export function projectCodexNotification(
  event: Extract<CodexNativeEvent, { kind: "notification" }>,
  threadId: string,
  turnId: string,
  emit: (event: Record<string, unknown>) => void,
): void {
  const params = event.params;
  if (!record(params) || params.threadId !== threadId) return;
  if (record(params.item) && typeof params.item.id === "string") {
    const item = params.item;
    if (
      event.method === "item/completed" &&
      item.type === "agentMessage" &&
      typeof item.text === "string"
    )
      emit({
        kind: "message.finished",
        turnId,
        messageId: item.id,
        role: "assistant",
        text: item.text,
      });
    if (event.method === "item/started" && item.type === "commandExecution")
      emit({ kind: "tool.started", turnId, toolCallId: item.id, name: "command" });
    if (event.method === "item/completed" && item.type === "commandExecution")
      emit({
        kind: "tool.finished",
        turnId,
        toolCallId: item.id,
        name: "command",
        outcome: item.status === "completed" ? "success" : "error",
      });
  } else if (
    event.method === "item/agentMessage/delta" &&
    typeof params.delta === "string" &&
    typeof params.itemId === "string"
  )
    emit({ kind: "text.delta", turnId, messageId: params.itemId, text: params.delta });
  else if (
    event.method === "thread/tokenUsage/updated" &&
    record(params.tokenUsage) &&
    record(params.tokenUsage.last)
  ) {
    const usage = params.tokenUsage.last;
    const metric = (value: unknown): number | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new Error("Invalid Codex native usage metric");
      return value;
    };
    const inputTokens = metric(usage.inputTokens);
    const outputTokens = metric(usage.outputTokens);
    if (inputTokens !== undefined || outputTokens !== undefined)
      emit({
        // 修复依据：原生 last 是每个 turn 的绝对快照；稳定 source 防止重复更新被累加，未报告字段不能伪造为 0。
        kind: "usage.accounted",
        turnId,
        sourceId: "codex-native-turn-usage",
        accounting: "absolute",
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      });
  }
}
