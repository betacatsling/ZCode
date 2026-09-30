import { isDeepStrictEqual } from "node:util";
import type { AgentEvent, CompatibleSessionSpec } from "@zcode/shared/agent-host";
import {
  sessionSummarySchema,
  sessionsIndexSnapshotSchema,
  sessionsIndexTopicFrameSchema,
  type SessionSummary,
  type SessionsIndexDelta,
  type SessionsIndexSnapshot,
  type SessionsIndexTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { projectHostConversation } from "./projector.js";
import type { ProjectionClientMode } from "./zcodeV4Projector.js";

export type SessionsIndexDelivery = {
  clientMode: ProjectionClientMode;
} & (
  | {
      mode: "snapshot";
      reason: "initial" | "epoch-changed" | "cursor-gap";
      frame: SessionsIndexTopicFrame;
    }
  | { mode: "resume"; reason: "caught-up" }
  | { mode: "resume"; reason: "deltas"; frame: SessionsIndexTopicFrame }
  | { mode: "resync"; reason: "sequence-gap" | "foreign-event"; sessionId: string }
);

interface IndexedSession {
  spec: CompatibleSessionSpec;
  runtimeEpoch: string;
  events: readonly AgentEvent[];
}

/** 侧栏索引的读模型。断档时保留上一份摘要，不把会话从列表里静默删掉。 */
export function createSessionsIndexPublisher(input: {
  workspaceId: string;
  logEpoch: string;
  topic: string;
  subscriptionId: string;
  now?: () => number;
}): {
  current: () => { seq: number; snapshot: SessionsIndexSnapshot };
  publish: (update: {
    sessions: readonly IndexedSession[];
    clientMode: ProjectionClientMode;
    base?: { logEpoch: string; seq: number };
  }) => SessionsIndexDelivery;
} {
  const now = input.now ?? (() => Date.now());
  let order: string[] = [];
  const summaries = new Map<string, SessionSummary>();
  const ops: SessionsIndexDelta[] = [];

  const snapshot = (): SessionsIndexSnapshot =>
    sessionsIndexSnapshotSchema.parse({
      protocolVersion: 1,
      workspaceId: input.workspaceId,
      logEpoch: input.logEpoch,
      sessions: order.flatMap((id) => {
        const summary = summaries.get(id);
        return summary ? [summary] : [];
      }),
    });

  const frame = (
    body: Pick<SessionsIndexTopicFrame, "fromSeq" | "toSeq" | "payload">,
  ): SessionsIndexTopicFrame =>
    sessionsIndexTopicFrameSchema.parse({
      topic: input.topic,
      subscriptionId: input.subscriptionId,
      sentAt: now(),
      ...body,
    });

  return {
    current: () => ({ seq: ops.length, snapshot: snapshot() }),
    publish(update) {
      const projected = projectAll(input.workspaceId, update.sessions);
      if (!projected.ok) {
        return {
          clientMode: update.clientMode,
          mode: "resync",
          reason: projected.reason,
          sessionId: projected.sessionId,
        };
      }
      const nextOrder: string[] = [];
      const seen = new Set<string>();
      for (const summary of projected.summaries) {
        if (seen.has(summary.sessionId)) throw new Error(`duplicate session ${summary.sessionId}`);
        seen.add(summary.sessionId);
        nextOrder.push(summary.sessionId);
        const previous = summaries.get(summary.sessionId);
        if (!previous || !isDeepStrictEqual(previous, summary)) {
          ops.push({ op: "session.upserted", session: summary });
        }
        summaries.set(summary.sessionId, summary);
      }
      for (const id of order) {
        if (seen.has(id)) continue;
        ops.push({ op: "session.removed", sessionId: id });
        summaries.delete(id);
      }
      order = nextOrder;
      const head = ops.length;
      const current = snapshot();
      const replace = (
        reason: "initial" | "epoch-changed" | "cursor-gap",
      ): SessionsIndexDelivery => ({
        clientMode: update.clientMode,
        mode: "snapshot",
        reason,
        frame: frame({ fromSeq: 0, toSeq: head, payload: { kind: "snapshot", snapshot: current } }),
      });
      const base = update.base;
      if (!base) return replace("initial");
      if (base.logEpoch !== input.logEpoch) return replace("epoch-changed");
      if (!Number.isSafeInteger(base.seq) || base.seq < 0 || base.seq > head)
        return replace("cursor-gap");
      if (base.seq === head)
        return { clientMode: update.clientMode, mode: "resume", reason: "caught-up" };
      return {
        clientMode: update.clientMode,
        mode: "resume",
        reason: "deltas",
        frame: frame({
          fromSeq: base.seq,
          toSeq: head,
          payload: { kind: "deltas", deltas: ops.slice(base.seq) },
        }),
      };
    },
  };
}

function projectAll(
  workspaceId: string,
  sessions: readonly IndexedSession[],
):
  | { ok: true; summaries: SessionSummary[] }
  | { ok: false; reason: "sequence-gap" | "foreign-event"; sessionId: string } {
  const summaries: SessionSummary[] = [];
  for (const session of sessions) {
    const sessionWorkspace =
      session.spec.schemaVersion === 2
        ? session.spec.workspaceId
        : (session.spec.execution.workspaceId ?? session.spec.execution.workspaceIdentity);
    if (sessionWorkspace !== workspaceId) {
      throw new Error(`sidebar summary workspace mismatch: ${session.spec.hostSessionId}`);
    }
    try {
      const conversation = projectHostConversation({
        spec: session.spec,
        runtimeEpoch: session.runtimeEpoch,
        events: session.events,
      });
      summaries.push(toSummary(session, conversation));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("sequence")) {
        return { ok: false, reason: "sequence-gap", sessionId: session.spec.hostSessionId };
      }
      if (message.includes("foreign")) {
        return { ok: false, reason: "foreign-event", sessionId: session.spec.hostSessionId };
      }
      throw error;
    }
  }
  return { ok: true, summaries };
}

function toSummary(
  session: IndexedSession,
  conversation: ReturnType<typeof projectHostConversation>,
): SessionSummary {
  const pending = conversation.pendingInteractions[0];
  const assistant = [...conversation.rows.window]
    .reverse()
    .find((row) => row.kind === "assistantText");
  const preview = assistant?.kind === "assistantText" ? assistant.text.slice(0, 120) : "";
  const createdAt = session.events[0]?.at ?? 0;
  const lastActivityAt = session.events[session.events.length - 1]?.at ?? createdAt;
  return sessionSummarySchema.parse({
    sessionId: session.spec.hostSessionId,
    ...(conversation.agentHost ? { agentHost: conversation.agentHost } : {}),
    workspaceId:
      session.spec.schemaVersion === 2
        ? session.spec.workspaceId
        : (session.spec.execution.workspaceId ?? session.spec.execution.workspaceIdentity),
    title: conversation.meta.title,
    titleSource: conversation.meta.titleSource,
    phase: conversation.control.phase,
    sessionEnded: conversation.control.sessionEnded,
    hasBackgroundWork: conversation.backgroundWorks.some((work) => work.status === "running"),
    ...(pending && pending.kind !== "workspaceHookReview"
      ? {
          pendingInteraction: {
            interactionId: pending.interactionId,
            kind: pending.kind,
            ...(pending.payload.kind === "permission"
              ? { toolName: pending.payload.toolName }
              : {}),
          },
        }
      : {}),
    pendingInteractionSummary: {
      permissionCount: conversation.pendingInteractions.filter((item) => item.kind === "permission")
        .length,
      userInputCount: conversation.pendingInteractions.filter((item) => item.kind === "userInput")
        .length,
    },
    lastActivityAt,
    ...(preview ? { lastAssistantPreview: preview } : {}),
    createdAt,
  });
}
