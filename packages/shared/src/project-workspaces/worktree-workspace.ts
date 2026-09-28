import { z } from "zod";
import { pathSchema, stableIdSchema } from "./ids.js";

const worktreeHeadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("branch"),
    ref: stableIdSchema,
    oid: z.string().trim().min(1).nullable(),
  }),
  z.strictObject({
    kind: z.literal("detached"),
    oid: z.string().trim().min(1),
  }),
]);

/**
 * Target-owned worktree facts. `isMainWorktree` is not inferred from the branch name.
 * `needsVerification` means the directory may have been recreated outside the host,
 * so the old session identity must not be reused from the path alone.
 */
export const worktreeWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stableIdSchema,
  projectId: stableIdSchema,
  repositoryBindingId: stableIdSchema,
  title: z.string().trim().min(1).max(256),
  workspaceIdentity: z.string().max(2048).optional(),
  worktreePath: pathSchema,
  worktreeGeneration: stableIdSchema,
  isMainWorktree: z.boolean(),
  head: worktreeHeadSchema,
  origin: z.enum(["created", "adopted"]),
  lifecycle: z.enum(["active", "archived", "missing", "removed"]),
  verification: z.enum(["verified", "needsVerification"]),
});
export type WorktreeWorkspace = z.infer<typeof worktreeWorkspaceSchema>;
