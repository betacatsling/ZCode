import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

/** Host identities are stable within a target; backend-native IDs are deliberately separate. */
export const executionTargetRefSchema = z.strictObject({
  targetId: z.string().trim().min(1).max(256),
  workspaceIdentity: z.string().trim().min(1).max(2048),
  worktreePath: z.string().trim().min(1).max(4096),
});
export type ExecutionTargetRef = z.infer<typeof executionTargetRefSchema>;

export const modelBindingRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host-managed"), selection: modelSelectionSchema }),
  z.strictObject({ kind: z.literal("harness-managed"), nativeModelId: z.string().min(1).optional() }),
]);
export type ModelBindingRequest = z.infer<typeof modelBindingRequestSchema>;

export const sessionSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hostSessionId: z.string().trim().min(1).max(256),
  execution: executionTargetRefSchema,
  harness: z.strictObject({
    id: z.string().trim().min(1).max(128),
    adapterVersion: z.string().trim().min(1).max(128),
  }),
  modelBinding: modelBindingRequestSchema,
});
export type SessionSpec = z.infer<typeof sessionSpecSchema>;

export const backendBindingSchema = z.strictObject({
  hostSessionId: sessionSpecSchema.shape.hostSessionId,
  backendSessionId: z.string().trim().min(1).max(512),
  backendVersion: z.string().trim().min(1).max(128),
  runtimeEpoch: z.string().trim().min(1).max(128),
});
export type BackendBinding = z.infer<typeof backendBindingSchema>;
