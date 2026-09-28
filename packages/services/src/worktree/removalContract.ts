import { z } from "zod";
import type { WorktreeWorkspace } from "@zcode/shared/agent-host";

const stableIdSchema = z.string().trim().min(1).max(256);

export const workspaceRemovalBlockerSchema = z.enum([
  "main-worktree",
  "not-linked-worktree",
  "stale-generation",
  "workspace-unverified",
  "workspace-unavailable",
  "workspace-frozen",
  "dirty",
  "untracked",
  "submodule",
  "locked",
  "native-busy",
  "native-unknown",
  "external-busy",
  "external-approval-pending",
  "external-unknown",
  "git-unavailable",
]);
export type WorkspaceRemovalBlocker = z.infer<typeof workspaceRemovalBlockerSchema>;

export const workspaceRemovalPreviewSchema = z.strictObject({
  workspaceId: stableIdSchema,
  targetId: stableIdSchema,
  expectedGeneration: stableIdSchema,
  safeToRemove: z.boolean(),
  blockers: z.array(workspaceRemovalBlockerSchema).max(32),
  risks: z.strictObject({
    dirty: z.boolean(),
    untracked: z.boolean(),
    submodule: z.boolean(),
    locked: z.boolean(),
  }),
  externalProcessBoundary: z.literal("unmanaged-writers-not-enumerated"),
  confirmationToken: stableIdSchema.optional(),
});
export type WorkspaceRemovalPreview = z.infer<typeof workspaceRemovalPreviewSchema>;

export const workspaceRemovalRequestSchema = z.strictObject({
  workspaceId: stableIdSchema,
  expectedGeneration: stableIdSchema,
  confirmationToken: stableIdSchema,
});
export type WorkspaceRemovalRequest = z.infer<typeof workspaceRemovalRequestSchema>;

/** Confirmation-only linked-worktree lifecycle API, kept separate from discovery ports. */
export interface IWorktreeRemovalService {
  previewRemoveWorkspace(input: {
    workspaceId: string;
    expectedGeneration: string;
  }): Promise<WorkspaceRemovalPreview>;
  removeWorkspace(request: WorkspaceRemovalRequest): Promise<WorktreeWorkspace>;
}
