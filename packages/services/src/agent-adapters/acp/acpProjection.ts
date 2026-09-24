type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface AcpTurnProjection {
  id: string;
  messageId: string;
  text: string;
  cancelled: boolean;
  tools: Map<string, { name: string; state: string }>;
  finishedTools: Set<string>;
}

/** ACP updates are observations only. Unknown extensions cannot execute a tool or authorize effects. */
export function projectAcpUpdate(
  value: unknown,
  turn: AcpTurnProjection,
  emit: (fields: Record<string, unknown>) => void,
): void {
  if (!object(value)) return;
  const content = object(value.content) ? value.content : undefined;
  switch (value.sessionUpdate) {
    case "agent_message_chunk":
      if (content?.type === "text" && typeof content.text === "string") {
        turn.text += content.text;
        emit({
          kind: "text.delta",
          turnId: turn.id,
          messageId: turn.messageId,
          text: content.text,
        });
      }
      break;
    case "agent_thought_chunk":
      if (content?.type === "text" && typeof content.text === "string")
        emit({
          kind: "extension.event",
          turnId: turn.id,
          namespace: "acp.reasoning",
          version: 1,
          payload: { text: content.text },
        });
      break;
    case "tool_call":
    case "tool_call_update": {
      if (
        typeof value.toolCallId !== "string" ||
        !value.toolCallId ||
        turn.finishedTools.has(value.toolCallId)
      )
        break;
      const previous = turn.tools.get(value.toolCallId);
      const name =
        typeof value.title === "string" && value.title
          ? value.title
          : (previous?.name ?? "ACP tool");
      if (!previous)
        emit({ kind: "tool.started", turnId: turn.id, toolCallId: value.toolCallId, name });
      if (value.status === "completed" || value.status === "failed") {
        emit({
          kind: "tool.finished",
          turnId: turn.id,
          toolCallId: value.toolCallId,
          name,
          outcome: value.status === "completed" ? "success" : "error",
        });
        turn.tools.delete(value.toolCallId);
        turn.finishedTools.add(value.toolCallId);
      } else turn.tools.set(value.toolCallId, { name, state: String(value.status ?? "pending") });
      break;
    }
    case "plan":
      if (Array.isArray(value.entries))
        emit({ kind: "plan.updated", turnId: turn.id, text: JSON.stringify(value.entries) });
      break;
    case "usage_update":
      if (
        Number.isSafeInteger(value.inputTokens) &&
        Number.isSafeInteger(value.outputTokens) &&
        (value.inputTokens as number) >= 0 &&
        (value.outputTokens as number) >= 0
      )
        emit({
          kind: "usage.reported",
          turnId: turn.id,
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
        });
      break;
    default:
      break;
  }
}
