import type { AgentEvent } from "@zcode/shared/agent-host";
import type { ClaudeTransportEvent } from "./claudeTransport.js";

export type ClaudePayload = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "hostSessionId" | "runtimeEpoch" | "sequence" | "eventId" | "at" | "turnId"> & {
        kind: E["kind"];
      }
    : never
  : never;

/** Only native frames observed within the live turn may become canonical Host events. */
export function projectClaudeEvent(
  nativeId: string,
  turn: {
    id: string;
    tools: Map<string, string>;
    interactions: Map<string, string>;
    transport: { cancel(): void };
  },
  event: ClaudeTransportEvent,
): ClaudePayload[] {
  if (event.type === "session") {
    if (event.nativeSessionId !== nativeId || event.version !== "2.1.263") {
      turn.transport.cancel();
      throw new Error("Claude native identity mismatch");
    }
    return [];
  }
  if (event.type === "text") return [{ kind: "text.delta", messageId: turn.id, text: event.text }];
  if (event.type === "tool") {
    turn.tools.set(event.id, event.name);
    return [{ kind: "tool.started", toolCallId: event.id, name: event.name }];
  }
  if (event.type === "toolResult") {
    const name = turn.tools.get(event.id);
    if (!name) return [];
    turn.tools.delete(event.id);
    return [
      {
        kind: "tool.finished",
        toolCallId: event.id,
        name,
        outcome: event.error ? "error" : "success",
        outputText: event.text,
      },
    ];
  }
  if (event.type === "permission") {
    turn.interactions.set(event.id, event.nativeToolId);
    return [
      {
        kind: "interaction.requested",
        interactionId: event.id,
        toolCallId: event.nativeToolId,
        summary: event.name,
      },
    ];
  }
  return [];
}
