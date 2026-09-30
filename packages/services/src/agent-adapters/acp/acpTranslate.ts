import type { AgentEvent } from "@zcode/shared/agent-host";
import { isRecord } from "./acpProtocol.js";

export interface AcpHostDraft {
  readonly kind: AgentEvent["kind"];
  readonly fields: Record<string, unknown>;
  readonly sourceEventId?: string;
}

export function translateAcpUpdate(input: {
  readonly update: unknown;
  readonly turnId: string;
  readonly startedTools: Set<string>;
}): AcpHostDraft[] {
  if (!isRecord(input.update)) return [extension("acp.update", { recognized: false })];
  const sessionUpdate =
    typeof input.update.sessionUpdate === "string" ? input.update.sessionUpdate : "";
  const sourceEventId = typeof input.update.id === "string" ? input.update.id : undefined;
  const messageId = `assistant-${input.turnId}`;
  if (sessionUpdate === "agent_message_chunk") {
    const text = readContentText(input.update.content);
    if (text === undefined) return [];
    return [
      {
        kind: "text.delta",
        fields: { turnId: input.turnId, messageId, text },
        ...(sourceEventId ? { sourceEventId } : {}),
      },
    ];
  }
  // 推理不是助手正文，只留不可执行的扩展事件。
  if (sessionUpdate === "agent_thought_chunk")
    return [extension("acp.thought", { recognized: true })];
  if (sessionUpdate === "user_message_chunk") return [];
  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
    return translateTool(input.update, input.turnId, input.startedTools, sourceEventId);
  }
  if (sessionUpdate === "plan" || sessionUpdate === "plan_update") {
    const text = planText(input.update);
    if (!text) return [extension("acp.update", { sessionUpdate })];
    return [
      {
        kind: "plan.updated",
        fields: { turnId: input.turnId, text },
        ...(sourceEventId ? { sourceEventId } : {}),
      },
    ];
  }
  if (sessionUpdate === "usage_update") {
    const usage = usageDraft(input.update, input.turnId);
    return usage ? [usage] : [extension("acp.update", { sessionUpdate })];
  }
  return [extension("acp.update", { sessionUpdate: sessionUpdate || "unknown" })];
}

function translateTool(
  update: Record<string, unknown>,
  turnId: string,
  startedTools: Set<string>,
  sourceEventId: string | undefined,
): AcpHostDraft[] {
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
  const name = typeof update.title === "string" && update.title.trim() ? update.title : "tool";
  if (!toolCallId) return [extension("acp.update", { sessionUpdate: "tool_call" })];
  const drafts: AcpHostDraft[] = [];
  if (!startedTools.has(toolCallId)) {
    startedTools.add(toolCallId);
    const inputText = completeJson(update.rawInput);
    drafts.push({
      kind: "tool.started",
      fields: { turnId, toolCallId, name, ...(inputText ? { inputText } : {}) },
      ...(sourceEventId ? { sourceEventId } : {}),
    });
  }
  const outcome = toolOutcome(update.status);
  if (outcome) {
    const outputText =
      typeof update.rawOutput === "string" ? update.rawOutput : completeJson(update.rawOutput);
    drafts.push({
      kind: "tool.finished",
      fields: { turnId, toolCallId, name, outcome, ...(outputText ? { outputText } : {}) },
      ...(sourceEventId ? { sourceEventId: `${sourceEventId}:finished` } : {}),
    });
  }
  return drafts;
}

function toolOutcome(status: unknown): "success" | "error" | "cancelled" | undefined {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled") return "cancelled";
  return undefined;
}

/** 只有完整 JSON 对象才能成为工具参数；半截文本留下次更新。 */
export function completeJson(value: unknown): string | undefined {
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed) || Array.isArray(parsed)) return JSON.stringify(parsed);
  } catch {
    return undefined;
  }
  return undefined;
}

function readContentText(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") return undefined;
  return value.text;
}

function planText(update: Record<string, unknown>): string | undefined {
  const entries = Array.isArray(update.entries)
    ? update.entries
    : Array.isArray(update.plan)
      ? update.plan
      : undefined;
  if (!entries) return undefined;
  const lines = entries.flatMap((entry) => {
    if (!isRecord(entry) || (typeof entry.content !== "string" && typeof entry.title !== "string"))
      return [];
    const text = typeof entry.content === "string" ? entry.content : entry.title;
    return typeof text === "string" && text.trim() ? [text.trim()] : [];
  });
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function usageDraft(update: Record<string, unknown>, turnId: string): AcpHostDraft | undefined {
  if (typeof update.inputTokens !== "number" || typeof update.outputTokens !== "number")
    return undefined;
  return {
    kind: "usage.reported",
    fields: { turnId, inputTokens: update.inputTokens, outputTokens: update.outputTokens },
  };
}

function extension(namespace: string, payload: Record<string, unknown>): AcpHostDraft {
  return { kind: "extension.event", fields: { namespace, version: 1, payload } };
}
