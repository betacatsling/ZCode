import { z } from "zod";

const eventBase = {
  hostSessionId: z.string().min(1),
  runtimeEpoch: z.string().min(1),
  sequence: z.number().int().positive(),
  eventId: z.string().min(1),
  sourceEventId: z.string().min(1).optional(),
  at: z.number().int().nonnegative(),
};
const turnEvent = { ...eventBase, turnId: z.string().min(1) };
const messageEvent = { ...turnEvent, messageId: z.string().min(1) };
const toolEvent = { ...turnEvent, toolCallId: z.string().min(1), name: z.string().min(1) };

/** Canonical host events; extension events remain inert data, never executable UI code. */
export const agentEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...turnEvent, kind: z.literal("turn.started") }),
  z.strictObject({ ...messageEvent, kind: z.literal("text.delta"), text: z.string() }),
  z.strictObject({ ...messageEvent, kind: z.literal("message.finished"), text: z.string(), role: z.enum(["assistant", "user"]) }),
  z.strictObject({ ...messageEvent, kind: z.literal("reasoning.started") }),
  z.strictObject({ ...messageEvent, kind: z.literal("reasoning.delta"), text: z.string() }),
  z.strictObject({ ...messageEvent, kind: z.literal("reasoning.finished"), text: z.string() }),
  z.strictObject({ ...toolEvent, kind: z.literal("tool.started"), inputText: z.string().optional() }),
  z.strictObject({ ...toolEvent, kind: z.literal("tool.finished"), outcome: z.enum(["success", "error", "cancelled"]), outputText: z.string().optional() }),
  z.strictObject({ ...toolEvent, kind: z.literal("file.changed"), path: z.string().min(1), additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }),
  z.strictObject({ ...turnEvent, kind: z.literal("interaction.requested"), interactionId: z.string().min(1), toolCallId: z.string().min(1), summary: z.string().min(1) }),
  z.strictObject({ ...turnEvent, kind: z.literal("question.requested"), interactionId: z.string().min(1), prompt: z.string().min(1).max(4096), freeText: z.boolean(), options: z.array(z.strictObject({ optionId: z.string().min(1).max(128), label: z.string().min(1).max(256) })).max(32).optional(), toolCallId: z.string().min(1).optional() }),
  z.strictObject({ ...turnEvent, kind: z.literal("question.answered"), interactionId: z.string().min(1) }),
  z.strictObject({ ...turnEvent, kind: z.literal("interaction.resolved"), interactionId: z.string().min(1), decision: z.enum(["allow", "deny"]) }),
  z.strictObject({ ...turnEvent, kind: z.literal("plan.updated"), text: z.string() }),
  z.strictObject({ ...turnEvent, kind: z.literal("plan.itemsUpdated"), items: z.array(z.strictObject({ id: z.string().min(1).max(256), content: z.string().max(4096), status: z.enum(["pending", "inProgress", "completed"]) })).max(128) }),
  z.strictObject({ ...turnEvent, kind: z.literal("subagent.updated"), childSessionId: z.string().min(1), status: z.enum(["started", "finished", "failed"]), childHarnessId: z.string().min(1).optional(), subagentType: z.string().min(1).optional(), parentToolCallId: z.string().min(1).optional(), summary: z.string().max(4096).optional() }),
  z.strictObject({ ...turnEvent, kind: z.literal("usage.reported"), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }),
  z.strictObject({ ...turnEvent, kind: z.literal("usage.accounted"), accounting: z.enum(["delta", "absolute"]), sourceId: z.string().min(1).max(256), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), cacheReadTokens: z.number().int().nonnegative().optional(), cacheWriteTokens: z.number().int().nonnegative().optional(), reasoningTokens: z.number().int().nonnegative().optional() }),
  z.strictObject({ ...turnEvent, kind: z.literal("turn.finished"), outcome: z.enum(["success", "cancelled", "failed", "unknown"]) }),
  z.strictObject({ ...eventBase, kind: z.literal("session.status"), state: z.enum(["idle", "running", "interrupted", "error", "execution-unknown"]) }),
  z.strictObject({ ...eventBase, kind: z.literal("session.error"), code: z.string().min(1), message: z.string().max(1024) }),
  z.strictObject({ ...eventBase, kind: z.literal("extension.event"), namespace: z.string().regex(/^[a-z][a-z0-9.-]+$/), version: z.number().int().positive(), payload: z.string().max(4096) }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
