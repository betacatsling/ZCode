import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import { hostSessionIdSchema } from "./ids.js";

export { backendBindingSchema, type BackendBinding } from "./backend-binding.js";

/** POSIX-relative lexical check only. Target realpath and symlink policy stay with the host. */
export const cwdRelativeToWorktreeSchema = z
  .string()
  .max(4096)
  .refine(
    (cwd) =>
      cwd === "." ||
      (cwd.length > 0 &&
        !cwd.startsWith("/") &&
        !/^[A-Za-z]:/.test(cwd) &&
        !cwd.includes("\\") &&
        !cwd.includes("\0") &&
        cwd.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")),
    "cwd must be a safe relative worktree path",
  );

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

const harnessRefSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  adapterVersion: z.string().trim().min(1).max(128),
});

/** Published v1 wire spec. Readers must keep accepting it; do not invent projectId on parse. */
export const sessionSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hostSessionId: hostSessionIdSchema,
  execution: executionTargetRefSchema,
  harness: harnessRefSchema,
  modelBinding: modelBindingRequestSchema,
});
export type SessionSpec = z.infer<typeof sessionSpecSchema>;

const sessionSpecV2ExecutionSchema = z.strictObject({
  targetId: z.string().trim().min(1).max(256),
  workspaceIdentity: z.string().min(1).max(4096),
  worktreePath: z.string().min(1).max(4096),
  worktreeGeneration: z.string().trim().min(1).max(256),
  cwdRelativeToWorktree: cwdRelativeToWorktreeSchema.default("."),
});

/** Plan §4 spec. Execution fields are derived by the host, not chosen by the renderer. */
export const sessionSpecV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  hostSessionId: hostSessionIdSchema,
  projectId: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(256),
  execution: sessionSpecV2ExecutionSchema,
  harness: harnessRefSchema,
  modelBinding: modelBindingRequestSchema,
});
export type SessionSpecV2 = z.infer<typeof sessionSpecV2Schema>;

export const compatibleSessionSpecSchema = z.discriminatedUnion("schemaVersion", [
  sessionSpecSchema,
  sessionSpecV2Schema,
]);
export type CompatibleSessionSpec = z.infer<typeof compatibleSessionSpecSchema>;

/** Accept either published generation. v1 is not upgraded, because it has no project id. */
export function parseCompatibleSessionSpec(value: unknown): CompatibleSessionSpec {
  return compatibleSessionSpecSchema.parse(value);
}

/** Cache and admission identity is the host session, never the workspace+harness pair. */
export function hostSessionCacheKey(spec: { readonly hostSessionId: string }): string {
  return hostSessionIdSchema.parse(spec.hostSessionId);
}

export function assertUniqueHostSessionIds(
  specs: readonly { readonly hostSessionId: string }[],
): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    const id = hostSessionIdSchema.parse(spec.hostSessionId);
    if (seen.has(id)) throw new Error(`duplicate-id:${id}`);
    seen.add(id);
  }
}
