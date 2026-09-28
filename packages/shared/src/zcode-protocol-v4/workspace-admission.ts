import { z } from "zod";

/** Native CLI owner read; does not activate sessions or replay commands. */
export const v4WorkspaceAdmissionQuiescenceParamsSchema = z.strictObject({
  workspacePath: z.string().min(1).max(4096),
  workspaceIdentity: z.string().trim().min(1).max(2048).optional(),
  worktreeGeneration: z.string().trim().min(1).max(256),
  startIfMissing: z.boolean().optional(),
});
export type V4WorkspaceAdmissionQuiescenceParams = z.infer<
  typeof v4WorkspaceAdmissionQuiescenceParamsSchema
>;

export const v4WorkspaceAdmissionQuiescenceResultSchema = z.strictObject({
  protocolVersion: z.literal(1),
  ownerEpoch: z.string().min(1).max(128),
  ownerPresent: z.boolean(),
  worktreeGeneration: z.string().trim().min(1).max(256),
  complete: z.boolean(),
  state: z.enum(["idle", "busy", "unknown"]),
  activeSessionCount: z.number().int().nonnegative(),
  activeTurnCount: z.number().int().nonnegative(),
  pendingCommandCount: z.number().int().nonnegative(),
  pendingInputCount: z.number().int().nonnegative(),
  pendingApprovalCount: z.number().int().nonnegative(),
});
export type V4WorkspaceAdmissionQuiescenceResult = z.infer<
  typeof v4WorkspaceAdmissionQuiescenceResultSchema
>;
