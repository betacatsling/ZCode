import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import {
  repositoryBindingSchema,
  worktreeWorkspaceSchema,
  type RepositoryBinding,
  type WorktreeWorkspace,
} from "../project-workspaces/index.js";

/** Host identities are stable within a target; backend-native IDs are deliberately separate. */
export const executionTargetRefSchema = z.strictObject({
  targetId: z.string().trim().min(1).max(256),
  workspaceIdentity: z.string().trim().min(1).max(2048),
  worktreePath: z.string().trim().min(1).max(4096),
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
/** @deprecated v1 compatibility only. Final new-session admission MUST use SessionSpecV2. */
export type SessionSpec = z.infer<typeof sessionSpecSchema>;
/** @deprecated v1 persisted read/migration only; not a writable v2 admission schema. */
export const legacySessionSpecSchema = sessionSpecSchema;
export type LegacySessionSpec = SessionSpec;

/** Lexical validation only; the target Host must additionally check realpath/symlink containment. */
export const cwdRelativeToWorktreeSchema = z
  .string()
  .max(4096)
  .refine(
    (cwd) =>
      cwd === "." ||
      (cwd.length > 0 &&
        !cwd.startsWith("/") &&
        !cwd.includes("\\") &&
        !cwd.includes("\0") &&
        cwd.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")),
    "cwd must be a safe relative worktree path",
  );
export const writableSessionSpecV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  hostSessionId: sessionSpecSchema.shape.hostSessionId,
  projectId: z.string().trim().min(1).max(256),
  workspaceId: z.string().trim().min(1).max(256),
  execution: executionTargetRefSchema.extend({
    worktreeGeneration: z.string().trim().min(1).max(256),
    cwdRelativeToWorktree: cwdRelativeToWorktreeSchema,
  }),
  harness: sessionSpecSchema.shape.harness,
  modelBinding: modelBindingRequestSchema,
});
export type SessionSpecV2 = z.infer<typeof writableSessionSpecV2Schema>;
export const readableSessionSpecSchema = z.discriminatedUnion("schemaVersion", [
  legacySessionSpecSchema,
  writableSessionSpecV2Schema,
]);

/** Only target-verified records may supply identity. No UI-provided execution overrides. */
export function deriveWritableSessionSpec(input: {
  hostSessionId: string;
  projectId: string;
  workspaceId: string;
  binding: RepositoryBinding;
  workspace: WorktreeWorkspace;
  expectedTargetId: string;
  expectedGeneration: string;
  cwdRelativeToWorktree?: string;
  harness: SessionSpecV2["harness"];
  modelBinding: ModelBindingRequest;
}): SessionSpecV2 {
  const binding = repositoryBindingSchema.parse(input.binding);
  const workspace = worktreeWorkspaceSchema.parse(input.workspace);
  if (
    workspace.id !== input.workspaceId ||
    workspace.projectId !== input.projectId ||
    workspace.repositoryBindingId !== binding.id ||
    binding.projectId !== input.projectId ||
    binding.executionTargetId !== input.expectedTargetId ||
    workspace.worktreeGeneration !== input.expectedGeneration ||
    workspace.lifecycle !== "active"
  )
    throw new Error("invalid-ownership-or-target");
  return writableSessionSpecV2Schema.parse({
    schemaVersion: 2,
    hostSessionId: input.hostSessionId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    execution: {
      targetId: binding.executionTargetId,
      workspaceIdentity: workspace.workspaceIdentity,
      worktreePath: workspace.worktreePath,
      worktreeGeneration: workspace.worktreeGeneration,
      cwdRelativeToWorktree: input.cwdRelativeToWorktree ?? ".",
    },
    harness: input.harness,
    modelBinding: input.modelBinding,
  });
}

export const backendBindingSchema = z.strictObject({
  hostSessionId: sessionSpecSchema.shape.hostSessionId,
  backendSessionId: z.string().trim().min(1).max(512),
  backendVersion: z.string().trim().min(1).max(128),
  runtimeEpoch: z.string().trim().min(1).max(128),
});
export type BackendBinding = z.infer<typeof backendBindingSchema>;
/** New persisted native binding is scoped to target, worktree generation and harness. */
export const backendBindingV2Schema = backendBindingSchema.extend({
  schemaVersion: z.literal(2),
  targetId: executionTargetRefSchema.shape.targetId,
  workspaceId: writableSessionSpecV2Schema.shape.workspaceId,
  worktreeGeneration: writableSessionSpecV2Schema.shape.execution.shape.worktreeGeneration,
  harnessId: writableSessionSpecV2Schema.shape.harness.shape.id,
});
export type BackendBindingV2 = z.infer<typeof backendBindingV2Schema>;
