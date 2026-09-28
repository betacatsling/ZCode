import type { AgentEvent } from "@zcode/shared/agent-host";

export type ClaudeCodeNativeEvent =
  | {
      readonly kind: "text.delta";
      readonly sourceEventId: string;
      readonly turnId: string;
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly kind: "message.finished";
      readonly sourceEventId: string;
      readonly turnId: string;
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly kind: "tool.started";
      readonly sourceEventId: string;
      readonly turnId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly inputText?: string;
    }
  | {
      readonly kind: "tool.finished";
      readonly sourceEventId: string;
      readonly turnId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly outcome: "success" | "error" | "cancelled";
      readonly outputText?: string;
    }
  | {
      readonly kind: "interaction.requested";
      readonly sourceEventId: string;
      readonly turnId: string;
      readonly interactionId: string;
      readonly toolCallId: string;
      readonly summary: string;
    }
  | {
      readonly kind: "usage.reported";
      readonly sourceEventId: string;
      readonly turnId: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | {
      readonly kind: "turn.finished";
      readonly sourceEventId: string;
      readonly turnId: string;
      readonly outcome: "success" | "cancelled" | "failed" | "unknown";
    }
  | {
      readonly kind: "sequence.gap";
      readonly sourceEventId: string;
      readonly turnId: string;
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ClaudeCodeTranslatedEvent = DistributiveOmit<
  AgentEvent,
  "hostSessionId" | "runtimeEpoch" | "sequence" | "eventId" | "at"
>;

/** Completed message text is a snapshot. Deltas are not repeated here. */
export function translateClaudeCodeNativeEvent(
  event: ClaudeCodeNativeEvent,
): ClaudeCodeTranslatedEvent | "gap" {
  switch (event.kind) {
    case "sequence.gap":
      return "gap";
    case "text.delta":
      return {
        kind: "text.delta",
        turnId: event.turnId,
        messageId: event.messageId,
        text: event.text,
        sourceEventId: event.sourceEventId,
      };
    case "message.finished":
      return {
        kind: "message.finished",
        turnId: event.turnId,
        messageId: event.messageId,
        text: event.text,
        role: "assistant",
        sourceEventId: event.sourceEventId,
      };
    case "tool.started":
      return {
        kind: "tool.started",
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        ...(event.inputText === undefined ? {} : { inputText: event.inputText }),
        sourceEventId: event.sourceEventId,
      };
    case "tool.finished":
      return {
        kind: "tool.finished",
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        outcome: event.outcome,
        ...(event.outputText === undefined ? {} : { outputText: event.outputText }),
        sourceEventId: event.sourceEventId,
      };
    case "interaction.requested":
      return {
        kind: "interaction.requested",
        turnId: event.turnId,
        interactionId: event.interactionId,
        toolCallId: event.toolCallId,
        summary: event.summary,
        sourceEventId: event.sourceEventId,
      };
    case "usage.reported":
      return {
        kind: "usage.reported",
        turnId: event.turnId,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        sourceEventId: event.sourceEventId,
      };
    case "turn.finished":
      return {
        kind: "turn.finished",
        turnId: event.turnId,
        outcome: event.outcome,
        sourceEventId: event.sourceEventId,
      };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

export function redactClaudeCodeText(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length < 12) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

export function redactClaudeCodeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactClaudeCodeText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactClaudeCodeValue(item, secrets));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = redactClaudeCodeValue(item, secrets);
    }
    return redacted;
  }
  return value;
}
