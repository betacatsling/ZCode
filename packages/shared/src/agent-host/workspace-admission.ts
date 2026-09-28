import { z } from "zod";

const stableIdSchema = z.string().trim().min(1).max(256);
const workspacePathSchema = z.string().min(1).max(4096);

/** One target-owned generation fence shared by native and external admission. */
export const workspaceAdmissionFenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetId: stableIdSchema,
  workspaceId: stableIdSchema,
  workspaceKey: z.string().min(1).max(4096),
  worktreePath: workspacePathSchema,
  worktreeGeneration: stableIdSchema,
  lifecycle: z.enum(["active", "archived", "frozen", "removed"]),
  freezeToken: stableIdSchema.optional(),
  previousLifecycle: z.enum(["active", "archived"]).optional(),
});
export type WorkspaceAdmissionFence = z.infer<typeof workspaceAdmissionFenceSchema>;

/** Identity is trimmed; the path fallback remains byte-for-byte unchanged. */
export function resolveWorkspaceAdmissionKey(
  workspaceIdentity: string | undefined,
  workspacePath: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}
