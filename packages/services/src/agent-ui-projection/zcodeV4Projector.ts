import { isDeepStrictEqual } from "node:util";
import type { AgentEvent, CompatibleSessionSpec } from "@zcode/shared/agent-host";
import {
  applyConversationDeltas,
  conversationTopicFrameSchema,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type StatePatch,
} from "@zcode/shared/zcode-protocol-v4";
import { projectHostConversation } from "./projector.js";

export type ProjectionClientMode = "desktop-continuous" | "web-remote-replayable";

export type ConversationDelivery = {
  clientMode: ProjectionClientMode;
} & (
  | {
      mode: "snapshot";
      reason: "initial" | "epoch-changed" | "cursor-gap" | "not-expressible";
      frame: ConversationTopicFrame;
    }
  | { mode: "resume"; reason: "caught-up" }
  | { mode: "resume"; reason: "deltas"; frame: ConversationTopicFrame }
  | { mode: "resync"; reason: "sequence-gap" | "foreign-event" }
);

const STATE_KEYS = [
  "revision",
  "control",
  "sharedContextImport",
  "availability",
  "inputRouting",
  "meta",
  "config",
  "modelTransition",
  "usage",
  "queue",
  "pendingInteractions",
  "pendingCommands",
  "backgroundWorks",
  "subagents",
  "workflowRuns",
  "goal",
  "plan",
  "workspaceHookAdmission",
] as const satisfies readonly (keyof ConversationSnapshot & keyof StatePatch)[];

/** 客户端施加规则：snapshot 整体替换；delta 必须接在当前 seq 之后，断档则重订阅。 */
export function applyProjectedConversationFrame(
  current: ConversationSnapshot | null,
  frame: ConversationTopicFrame,
): ConversationSnapshot {
  if (frame.payload.kind === "snapshot") {
    if (frame.fromSeq !== 0 || frame.payload.snapshot.seq !== frame.toSeq) {
      throw new Error("snapshot frame must replace from zero");
    }
    return frame.payload.snapshot;
  }
  if (!current || frame.fromSeq !== current.seq) {
    throw new Error("delta sequence gap; resubscribe");
  }
  return { ...applyConversationDeltas(current, frame.payload.deltas), seq: frame.toSeq };
}

export function projectConversationDelivery(input: {
  spec: CompatibleSessionSpec;
  runtimeEpoch: string;
  events: readonly AgentEvent[];
  topic: string;
  subscriptionId: string;
  clientMode: ProjectionClientMode;
  base?: { logEpoch: string; seq: number };
  windowSize?: number;
  now?: number;
}): ConversationDelivery {
  const projected = tryProject(input);
  if (!projected.ok)
    return { clientMode: input.clientMode, mode: "resync", reason: projected.reason };
  const head = projected.snapshot;
  const sentAt = input.now ?? Date.now();
  const snapshot = (reason: "initial" | "epoch-changed" | "cursor-gap" | "not-expressible") => ({
    clientMode: input.clientMode,
    mode: "snapshot" as const,
    reason,
    frame: frame(input, sentAt, {
      fromSeq: 0,
      toSeq: head.seq,
      payload: { kind: "snapshot", snapshot: head },
    }),
  });
  const base = input.base;
  if (!base) return snapshot("initial");
  if (base.logEpoch !== input.runtimeEpoch) return snapshot("epoch-changed");
  if (!Number.isSafeInteger(base.seq) || base.seq < 0 || base.seq > head.seq)
    return snapshot("cursor-gap");
  if (base.seq === head.seq)
    return { clientMode: input.clientMode, mode: "resume", reason: "caught-up" };
  const prefix = projectHostConversation({
    spec: input.spec,
    runtimeEpoch: input.runtimeEpoch,
    events: input.events.slice(0, base.seq),
    ...(input.windowSize !== undefined ? { windowSize: input.windowSize } : {}),
  });
  const deltas = diffConversationSnapshots(prefix, head);
  if (!deltas || deltas.length === 0) return snapshot("not-expressible");
  return {
    clientMode: input.clientMode,
    mode: "resume",
    reason: "deltas",
    frame: frame(input, sentAt, {
      fromSeq: base.seq,
      toSeq: head.seq,
      payload: { kind: "deltas", deltas },
    }),
  };
}

function frame(
  input: { topic: string; subscriptionId: string },
  sentAt: number,
  body: Pick<ConversationTopicFrame, "fromSeq" | "toSeq" | "payload">,
): ConversationTopicFrame {
  return conversationTopicFrameSchema.parse({
    topic: input.topic,
    subscriptionId: input.subscriptionId,
    sentAt,
    ...body,
  });
}

function tryProject(input: {
  spec: CompatibleSessionSpec;
  runtimeEpoch: string;
  events: readonly AgentEvent[];
  windowSize?: number;
}):
  | { ok: true; snapshot: ConversationSnapshot }
  | { ok: false; reason: "sequence-gap" | "foreign-event" } {
  try {
    return {
      ok: true,
      snapshot: projectHostConversation({
        spec: input.spec,
        runtimeEpoch: input.runtimeEpoch,
        events: input.events,
        ...(input.windowSize !== undefined ? { windowSize: input.windowSize } : {}),
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("sequence")) return { ok: false, reason: "sequence-gap" };
    if (message.includes("foreign")) return { ok: false, reason: "foreign-event" };
    throw error;
  }
}

function diffConversationSnapshots(
  before: ConversationSnapshot,
  after: ConversationSnapshot,
): ConversationDelta[] | null {
  const deltas: ConversationDelta[] = [];
  const beforeRows = before.rows.window;
  const afterRows = after.rows.window;
  const beforeById = new Map(beforeRows.map((row) => [row.rowId, row]));
  const afterIds = new Set(afterRows.map((row) => row.rowId));
  const removed = beforeRows.filter((row) => !afterIds.has(row.rowId));
  if (removed.length > 0) {
    const firstRemoved = beforeRows.findIndex((row) => !afterIds.has(row.rowId));
    const suffix = beforeRows.slice(firstRemoved);
    const fromRow = suffix[0];
    if (
      !fromRow ||
      suffix.some((row) => afterIds.has(row.rowId)) ||
      suffix.length !== removed.length
    ) {
      return null;
    }
    deltas.push({ op: "row.removed", fromRowId: fromRow.rowId });
  }
  const appended = afterRows.filter((row) => !beforeById.has(row.rowId));
  const maxKept = beforeRows.reduce(
    (max, row) => (afterIds.has(row.rowId) ? Math.max(max, row.rowId) : max),
    0,
  );
  if (appended.some((row) => row.rowId <= maxKept)) return null;
  const tail = afterRows.slice(afterRows.length - appended.length);
  if (tail.some((row, index) => row.rowId !== appended[index]?.rowId)) return null;
  for (const row of appended) deltas.push({ op: "row.appended", row });
  for (const afterRow of afterRows) {
    const beforeRow = beforeById.get(afterRow.rowId);
    if (!beforeRow || isDeepStrictEqual(beforeRow, afterRow)) continue;
    const streamed = streamAppend(beforeRow, afterRow);
    if (streamed) {
      deltas.push({
        op: "row.delta",
        rowId: afterRow.rowId,
        path: streamed.path,
        append: streamed.append,
      });
    } else {
      deltas.push({ op: "row.upserted", row: afterRow });
    }
  }
  const patch: StatePatch = {};
  let patched = false;
  for (const key of STATE_KEYS) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    (patch as Record<string, unknown>)[key] = after[key];
    patched = true;
  }
  if (patched) deltas.push({ op: "state.updated", patch });
  if (deltas.length === 0)
    return isDeepStrictEqual({ ...before, seq: after.seq }, after) ? [] : null;
  const applied = applyConversationDeltas(before, deltas);
  return isDeepStrictEqual({ ...applied, seq: after.seq }, after) ? deltas : null;
}

function streamAppend(
  before: ConversationRow,
  after: ConversationRow,
): { path: "text"; append: string } | null {
  if (
    (before.kind !== "assistantText" && before.kind !== "reasoning") ||
    before.kind !== after.kind ||
    before.state !== "streaming" ||
    after.state !== "streaming" ||
    !after.text.startsWith(before.text) ||
    after.text.length === before.text.length
  ) {
    return null;
  }
  const { text: beforeText, ...beforeRest } = before;
  const { text: afterText, ...afterRest } = after;
  void beforeText;
  void afterText;
  if (!isDeepStrictEqual(beforeRest, afterRest)) return null;
  return { path: "text", append: after.text.slice(before.text.length) };
}
