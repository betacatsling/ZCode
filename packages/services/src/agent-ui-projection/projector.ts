import {
  conversationSnapshotSchema,
  type ConversationRow,
  type ConversationSnapshot,
  type PendingInteraction,
  type ToolCallRow,
  type TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  AgentEvent,
  AgentModelFailure,
  CompatibleSessionSpec,
} from "@zcode/shared/agent-host";
import { createExternalEventProjection } from "./externalEventProjection.js";

const unavailable = { allowed: false as const, reasonCode: "externalHarnessUnsupported" };

/** Pure V4 read projection. Replay never sends a prompt, performs a tool, or resolves approval. */
export function projectHostConversation(input: {
  spec: CompatibleSessionSpec;
  runtimeEpoch: string;
  events: readonly AgentEvent[];
  windowSize?: number;
  /** Optional exclusive cursor for a bounded historical page. */
  beforeRowId?: number;
}): ConversationSnapshot {
  const { spec, runtimeEpoch, events } = input;
  const windowSize = input.windowSize ?? 100;
  if (!Number.isSafeInteger(windowSize) || windowSize < 1 || windowSize > 500)
    throw new Error("invalid rows window size");
  if (
    input.beforeRowId !== undefined &&
    (!Number.isSafeInteger(input.beforeRowId) || input.beforeRowId < 1)
  ) {
    throw new Error("invalid rows cursor");
  }
  const rows: ConversationRow[] = [];
  const headers = new Map<string, TurnHeaderRow>();
  const messages = new Map<string, ConversationRow>();
  const tools = new Map<string, ToolCallRow>();
  const interactions = new Map<string, PendingInteraction>();
  /** Tool rows created by an approval request that arrived before its tool.started. */
  const seededByApproval = new Set<string>();
  let activeTurn: string | undefined;
  let phase: ConversationSnapshot["control"]["phase"] = "draft";
  let errorCode: string | undefined;
  let errorMessage = "";
  let lastErrorAt = 0;
  let errorFailure: AgentModelFailure | undefined;
  const external = createExternalEventProjection();
  let inputTokens = 0;
  let outputTokens = 0;
  let revision = 0;
  let seq = 0;
  let startedAt = 0;
  const base = (event: AgentEvent) => ({
    rowId: rows.length + 1,
    turnId: "turnId" in event ? event.turnId : "host",
    createdAt: event.at,
    createdAtSeq: event.sequence,
  });
  for (const event of events) {
    if (event.hostSessionId !== spec.hostSessionId || event.runtimeEpoch !== runtimeEpoch)
      throw new Error("foreign projection event");
    if (event.sequence !== seq + 1)
      throw new Error("projection event sequence gap, duplicate or reorder");
    seq = event.sequence;
    revision++;
    switch (event.kind) {
      case "turn.started": {
        if (activeTurn || headers.has(event.turnId))
          throw new Error("concurrent or duplicate turn in single-session projection");
        activeTurn = event.turnId;
        startedAt = event.at;
        phase = "running";
        const header: TurnHeaderRow = {
          ...base(event),
          kind: "turnHeader",
          origin: "userInput",
          executionKind: "agent",
          state: "running",
          startedAt: event.at,
        };
        rows.push(header);
        headers.set(event.turnId, header);
        break;
      }
      case "text.delta": {
        if (event.turnId !== activeTurn) throw new Error("text outside active turn");
        let row = messages.get(event.messageId);
        if (!row) {
          row = {
            ...base(event),
            kind: "assistantText",
            text: "",
            state: "streaming",
            assistantResponseId: event.messageId,
          };
          rows.push(row);
          messages.set(event.messageId, row);
        }
        if (row.kind !== "assistantText" || row.state !== "streaming")
          throw new Error("text after final message");
        row.text += event.text;
        break;
      }
      case "message.finished": {
        if (event.turnId !== activeTurn) throw new Error("message outside active turn");
        const existing = messages.get(event.messageId);
        if (event.role === "user") {
          if (existing) throw new Error("duplicate user message");
          const row: ConversationRow = {
            ...base(event),
            kind: "userInput",
            text: event.text,
            origin: "realUser",
          };
          rows.push(row);
          messages.set(event.messageId, row);
        } else if (existing) {
          if (existing.kind !== "assistantText" || existing.state !== "streaming")
            throw new Error("duplicate terminal message");
          // Terminal text is authoritative and replaces deltas, never appends to them.
          existing.text = event.text;
          existing.state = "complete";
        } else {
          const row: ConversationRow = {
            ...base(event),
            kind: "assistantText",
            text: event.text,
            state: "complete",
            assistantResponseId: event.messageId,
          };
          rows.push(row);
          messages.set(event.messageId, row);
        }
        break;
      }
      case "tool.started": {
        if (event.turnId !== activeTurn) throw new Error("duplicate tool or wrong turn");
        if (external.hasFileSeed(event.toolCallId)) {
          external.adoptFileSeed(event, tools);
          break;
        }
        const seeded = seededByApproval.has(event.toolCallId)
          ? tools.get(event.toolCallId)
          : undefined;
        if (seeded) {
          // 审批先到时已建好占位行：只补工具名和参数，保留审批结果（等待/放行/拒绝）。
          if (seeded.turnId !== event.turnId) throw new Error("duplicate tool or wrong turn");
          seededByApproval.delete(event.toolCallId);
          seeded.toolName = event.name;
          if (event.inputText !== undefined) seeded.inputText = event.inputText;
          // 审批卡在请求投影时复制了占位名 "unknown"；仍在等待时同步真实工具名。已裁决的审批不动。
          const pending = seeded.approvalInteractionId
            ? interactions.get(seeded.approvalInteractionId)
            : undefined;
          if (pending?.payload.kind === "permission") pending.payload.toolName = event.name;
          break;
        }
        if (tools.has(event.toolCallId)) throw new Error("duplicate tool or wrong turn");
        const row: ToolCallRow = {
          ...base(event),
          kind: "toolCall",
          toolCallId: event.toolCallId,
          toolName: event.name,
          inputText: event.inputText ?? "",
          status: "running",
          startedAt: event.at,
        };
        rows.push(row);
        tools.set(event.toolCallId, row);
        break;
      }
      case "interaction.requested": {
        if (event.turnId !== activeTurn || interactions.has(event.interactionId))
          throw new Error("unmatched approval request");
        let row = tools.get(event.toolCallId);
        if (!row) {
          // ACP session/request_permission 等可以先于 tool.started 到达；Host 已把它记进 journal。
          // 这里建占位工具行承载审批，而不是让之后每次 snapshot 都抛错、审批永远不可见。
          row = {
            ...base(event),
            kind: "toolCall",
            toolCallId: event.toolCallId,
            toolName: "unknown",
            inputText: "",
            status: "pendingApproval",
            startedAt: event.at,
          };
          rows.push(row);
          tools.set(event.toolCallId, row);
          seededByApproval.add(event.toolCallId);
        }
        if (row.turnId !== event.turnId) throw new Error("unmatched approval request");
        row.status = "pendingApproval";
        row.approvalInteractionId = event.interactionId;
        interactions.set(event.interactionId, {
          interactionId: event.interactionId,
          kind: "permission",
          anchorRowId: row.rowId,
          createdAt: event.at,
          payload: {
            kind: "permission",
            toolCallId: row.toolCallId,
            toolName: row.toolName,
            summary: event.summary,
            detail: null,
            options: [
              { optionId: "allow", label: "Allow once", kind: "allowOnce" },
              { optionId: "deny", label: "Deny", kind: "deny" },
            ],
          },
        });
        break;
      }
      case "interaction.resolved": {
        const pending = interactions.get(event.interactionId);
        if (event.turnId !== activeTurn || !pending) throw new Error("stale approval resolution");
        const row = tools.get(
          pending.payload.kind === "permission" ? pending.payload.toolCallId : "",
        );
        if (row) {
          row.approvalInteractionId = undefined;
          row.status = event.decision === "deny" ? "cancelled" : "running";
        }
        interactions.delete(event.interactionId);
        break;
      }
      case "tool.finished": {
        const row = tools.get(event.toolCallId);
        if (!row || row.turnId !== event.turnId || event.turnId !== activeTurn)
          throw new Error("tool result without active tool");
        if (row.status === "pendingApproval")
          throw new Error("tool completed before approval resolution");
        if (row.status === "cancelled" && event.outcome === "success")
          throw new Error("denied tool reported success");
        row.status =
          event.outcome === "success"
            ? "success"
            : event.outcome === "error"
              ? "error"
              : "cancelled";
        row.endedAt = event.at;
        if (event.outcome === "error")
          row.error = { code: "backend-tool-error", message: "Tool failed" };
        external.onToolFinished(event, row);
        break;
      }
      case "file.changed":
        external.onFileChanged(event, { headers, tools, rows, base });
        break;
      case "usage.reported":
        inputTokens += event.inputTokens;
        outputTokens += event.outputTokens;
        break;
      case "turn.finished": {
        if (activeTurn !== event.turnId) throw new Error("turn completed out of order");
        const header = headers.get(event.turnId)!;
        header.state =
          event.outcome === "success"
            ? "completedSuccess"
            : event.outcome === "cancelled"
              ? "completedInterrupted"
              : "failed";
        header.endedAt = event.at;
        header.activeMs = Math.max(0, event.at - startedAt);
        for (const pending of interactions.keys()) interactions.delete(pending);
        for (const row of tools.values()) {
          if (
            row.turnId === event.turnId &&
            (row.status === "running" || row.status === "pendingApproval")
          )
            row.status = "cancelled";
        }
        phase =
          event.outcome === "success"
            ? "completedSuccess"
            : event.outcome === "cancelled"
              ? "completedInterrupted"
              : "error";
        activeTurn = undefined;
        break;
      }
      case "session.status":
        if (event.state === "execution-unknown" || event.state === "error") phase = "error";
        break;
      case "session.error":
        // 保留宿主给出的 message，不用固定文案盖掉。
        errorCode = event.code;
        errorMessage = event.message;
        lastErrorAt = event.at;
        errorFailure = event.failure;
        phase = "error";
        break;
      case "plan.updated":
        if (!headers.has(event.turnId)) throw new Error("plan outside turn");
        external.onPlan(event);
        break;
      case "subagent.updated":
        if (!headers.has(event.turnId)) throw new Error("subagent outside turn");
        external.onSubagent(event, rows, base);
        break;
      case "extension.event":
        external.onExtension(event, rows, base);
        break;
    }
  }
  const lastError = errorCode
    ? {
        code: errorCode,
        message: errorMessage,
        recoverable: false,
        at: lastErrorAt,
        source: "runtime" as const,
        ...(errorFailure ? { failure: errorFailure } : {}),
      }
    : null;
  const eligibleRows =
    input.beforeRowId === undefined ? rows : rows.filter((row) => row.rowId < input.beforeRowId!);
  const window = eligibleRows.slice(-windowSize);
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId: spec.hostSessionId,
    logEpoch: runtimeEpoch,
    seq,
    revision,
    agentHost: {
      schemaVersion: 1,
      harnessId: spec.harness.id,
      targetId: spec.execution.targetId,
      hostSessionId: spec.hostSessionId,
      modelBindingKind: spec.modelBinding.kind,
    },
    control: {
      phase,
      sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
      canStop: !!activeTurn,
      stopState: activeTurn ? "stoppable" : "idle",
      stopTargetKind: activeTurn ? "assistant" : "unknown",
      activeWorks: activeTurn
        ? [{ kind: "primaryTurn", foregroundExecutionId: activeTurn, startedAt }]
        : [],
      lastError,
      apiRetry: null,
    },
    availability: {
      fork: unavailable,
      compact: unavailable,
      switchModelConfig: unavailable,
      setFollowupMode: unavailable,
      queueEdit: unavailable,
      sendQueuedNow: unavailable,
      pauseGoal: unavailable,
      resumeGoal: unavailable,
    },
    inputRouting: activeTurn
      ? { mode: "reject", reasonCode: "externalTurnBusy" }
      : { mode: "startNow" },
    meta: { title: "", titleSource: "default" },
    config: {
      modelSelection:
        spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection : undefined,
      provider:
        spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection.providerId : "",
      model:
        spec.modelBinding.kind === "host-managed"
          ? spec.modelBinding.selection.modelId
          : (spec.modelBinding.nativeModelId ?? ""),
      thought:
        spec.modelBinding.kind === "host-managed"
          ? (spec.modelBinding.selection.options?.reasoningLevel ?? "")
          : "",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: null,
      cumulative: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [...interactions.values()],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: external.subagents(),
    goal: null,
    plan: external.plan,
    workspaceHookAdmission: null,
    // firstRowId is the full projection's oldest row, not the tail window's
    // first row; the renderer uses it to decide whether rowsRange can page.
    rows: { window, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  });
}
