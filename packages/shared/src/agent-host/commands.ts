import { z } from "zod";
import { agentModelFailureSchema } from "./events.js";

const commandBase = {
  commandId: z.string().trim().min(1).max(256),
  hostSessionId: z.string().trim().min(1).max(256),
};
const turnCommand = {
  ...commandBase,
  runtimeEpoch: z.string().trim().min(1).max(128),
  turnId: z.string().trim().min(1).max(256),
};

/** Detach is not cancel; stale stop/approval cannot affect a later turn/epoch. */
export const agentCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...commandBase, type: z.literal("createSession") }),
  z.strictObject({
    ...commandBase,
    type: z.literal("send"),
    turnId: z.string().min(1),
    text: z.string().min(1),
  }),
  z.strictObject({ ...turnCommand, type: z.literal("cancelTurn") }),
  z.strictObject({
    ...turnCommand,
    type: z.literal("resolveInteraction"),
    interactionId: z.string().min(1),
    decision: z.enum(["allow", "deny"]),
    answer: z.string().optional(),
  }),
  z.strictObject({ ...commandBase, type: z.literal("detach") }),
  z.strictObject({ ...commandBase, type: z.literal("terminateSession") }),
  z.strictObject({
    ...commandBase,
    type: z.literal("resumeExecution"),
    runtimeEpoch: z.string().min(1),
  }),
  z.strictObject({ ...commandBase, type: z.literal("viewHistory") }),
]);
export type AgentCommand = z.infer<typeof agentCommandSchema>;

export const agentErrorCodeSchema = z.enum([
  "unknown-harness",
  "unsupported",
  "invalid-binding",
  "target-unavailable",
  "duplicate-id",
  "stale-epoch",
  "stale-turn",
  "stale-interaction",
  "execution-unknown",
  "backend-failure",
  "provider-reconfigure-required",
]);
export type AgentErrorCode = z.infer<typeof agentErrorCodeSchema>;
export const agentCommandReceiptSchema = z.strictObject({
  commandId: z.string().min(1),
  status: z.enum(["accepted", "completed", "duplicate", "rejected", "execution-unknown"]),
  reasonCode: agentErrorCodeSchema.optional(),
  message: z.string().max(1024).optional(),
  /** Key-free typed cause for provider-reconfigure-required refusals. */
  failure: agentModelFailureSchema.optional(),
});
export type AgentCommandReceipt = z.infer<typeof agentCommandReceiptSchema>;
