import { z } from "zod";
import { modelBindingRequestSchema } from "./session-spec.js";
import { modelSelectionSchema } from "../model-selection.js";
import { capabilityReportSchema } from "./capabilities.js";
import { agentModelFailureSchema } from "./events.js";

const stableId = z.string().trim().min(1).max(256);

/** Native ZCode keeps ModelSelection semantics; external owners use the existing binding contract. */
export const workspaceSessionModelBindingSchema = z.union([
  z.strictObject({ kind: z.literal("native-selection"), selection: modelSelectionSchema }),
  modelBindingRequestSchema,
]);
export type WorkspaceSessionModelBinding = z.infer<typeof workspaceSessionModelBindingSchema>;

/** Caller selects an adopted workspace by ID and expected generation, never by path or target. */
export const workspaceSessionCreateRequestSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(256),
  workspaceId: stableId,
  worktreeGeneration: stableId,
  harnessId: stableId,
  modelBinding: workspaceSessionModelBindingSchema,
  title: z.string().trim().min(1).max(256).optional(),
});
export type WorkspaceSessionCreateRequest = z.infer<typeof workspaceSessionCreateRequestSchema>;

/** Host-owned read-only capability probe for the selected Harness/model pair. */
export const workspaceSessionBindingCapabilityRequestSchema = z.strictObject({
  harnessId: stableId,
  modelBinding: workspaceSessionModelBindingSchema,
});
export type WorkspaceSessionBindingCapabilityRequest = z.infer<
  typeof workspaceSessionBindingCapabilityRequestSchema
>;

export const workspaceSessionBindingCapabilityResultSchema = z.strictObject({
  targetId: stableId,
  report: capabilityReportSchema,
  /** Key-free: the Provider's current credential was rejected (401); host-managed turns are refused. */
  credentialAttention: agentModelFailureSchema.optional(),
});
export type WorkspaceSessionBindingCapabilityResult = z.infer<
  typeof workspaceSessionBindingCapabilityResultSchema
>;

/** Host-stamped native V4 association. The fingerprint is over normalized safe request fields. */
export const managedWorkspaceSessionAssociationSchema = z.strictObject({
  targetId: stableId,
  workspaceId: stableId,
  worktreeGeneration: stableId,
  requestId: z.string().trim().min(1).max(256),
  requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ManagedWorkspaceSessionAssociation = z.infer<
  typeof managedWorkspaceSessionAssociationSchema
>;

/** Original owner locator; workspace paths remain owner facts and are never synthesized by UI. */
export const workspaceSessionOwnerLocatorSchema = z.strictObject({
  ownerKind: z.enum(["native-v4", "agent-host"]),
  sessionId: stableId,
  targetId: stableId,
  workspaceId: stableId,
  worktreeGeneration: stableId,
  /** Optional explicit identity; path fallback remains in workspacePath. */
  workspaceIdentity: z.string().min(1).max(2048).optional(),
  workspacePath: z.string().min(1).max(4096),
  harnessId: stableId,
  title: z.string().max(256).optional(),
  modelBinding: workspaceSessionModelBindingSchema.optional(),
  /** A receipt proves creation only; it does not establish current runtime state. */
  ownerFactSource: z.enum(["owner-index", "creation-receipt"]).optional(),
});
export type WorkspaceSessionOwnerLocator = z.infer<typeof workspaceSessionOwnerLocatorSchema>;

export const workspaceSessionCreateResultSchema = z.strictObject({
  locator: workspaceSessionOwnerLocatorSchema,
  reused: z.boolean(),
});
export type WorkspaceSessionCreateResult = z.infer<typeof workspaceSessionCreateResultSchema>;

export const workspaceSessionOwnersRequestSchema = z.strictObject({
  workspaceId: stableId,
  worktreeGeneration: stableId,
  /** Read retained history for this workspace, including older generations. */
  includeHistory: z.boolean().optional(),
});
export type WorkspaceSessionOwnersRequest = z.infer<typeof workspaceSessionOwnersRequestSchema>;

export const workspaceSessionOwnersResultSchema = z.strictObject({
  targetId: stableId,
  workspaceId: stableId,
  worktreeGeneration: stableId,
  sessions: z.array(workspaceSessionOwnerLocatorSchema).max(10_000),
});
export type WorkspaceSessionOwnersResult = z.infer<typeof workspaceSessionOwnersResultSchema>;
