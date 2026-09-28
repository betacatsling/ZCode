import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

/** Host identities are stable within a target; backend-native IDs are deliberately separate. */
export const executionTargetRefSchema = z.strictObject({
  targetId: z.string().trim().min(1).max(256),
  // SessionSpec V1 这个旧字段实际保存 canonical workspace key；fallback 可能是路径，解析时不能 trim，否则会改写目录身份。
  // 显式 identity 已在构造 key 前 trim，这里只保留持久化字节。
  workspaceIdentity: z.string().min(1).max(4096),
  // Filesystem paths are opaque; trimming can select a different directory.
  worktreePath: z.string().min(1).max(4096),
  workspaceId: z.string().trim().min(1).max(256).optional(),
  worktreeGeneration: z.string().trim().min(1).max(256).optional(),
});
export type ExecutionTargetRef = z.infer<typeof executionTargetRefSchema>;

export const modelBindingRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("host-managed"), selection: modelSelectionSchema }),
  z.strictObject({
    kind: z.literal("harness-managed"),
    nativeModelId: z.string().min(1).optional(),
  }),
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
