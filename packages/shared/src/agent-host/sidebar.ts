import { z } from "zod";
import { harnessIconResolutionSchema } from "./directory.js";
import { worktreeWorkspaceSchema } from "./hierarchy.js";

const stableSidebarIdSchema = z.string().trim().min(1).max(256);

export const sidebarSessionKindSchema = z.enum(["top-level", "terminal", "internal"]);
export type SidebarSessionKind = z.infer<typeof sidebarSessionKindSchema>;

export const sidebarActivitySchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting",
  "cancelling",
  "unknown",
]);
export type SidebarActivity = z.infer<typeof sidebarActivitySchema>;

export const sidebarFreshnessSchema = z.enum(["live", "stale", "offline", "unknown"]);
export type SidebarFreshness = z.infer<typeof sidebarFreshnessSchema>;

export const sidebarRecentOutcomeSchema = z.enum([
  "none",
  "success",
  "failed",
  "cancelled",
  "unknown",
]);
export type SidebarRecentOutcome = z.infer<typeof sidebarRecentOutcomeSchema>;

export const sidebarAttentionSchema = z.enum([
  "pending",
  "error",
  "unknown",
  "running",
  "unread",
  "idle",
]);
export type SidebarAttention = z.infer<typeof sidebarAttentionSchema>;

/** Runtime facts are a bounded projection from Host; they are never UI-owned truth. */
export const sidebarSessionRuntimeSummarySchema = z.strictObject({
  sessionId: stableSidebarIdSchema,
  workspaceId: stableSidebarIdSchema,
  activity: sidebarActivitySchema,
  freshness: sidebarFreshnessSchema,
  recentOutcome: sidebarRecentOutcomeSchema,
  unread: z.boolean(),
  pendingInteractionCount: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  kind: sidebarSessionKindSchema,
});
export type SidebarSessionRuntimeSummary = z.infer<typeof sidebarSessionRuntimeSummarySchema>;

export const sidebarDirectoryStatusSchema = z.enum(["registered", "unavailable", "unknown"]);
export type SidebarDirectoryStatus = z.infer<typeof sidebarDirectoryStatusSchema>;

export const sidebarSessionRowSchema = z.strictObject({
  sessionId: stableSidebarIdSchema,
  workspaceId: stableSidebarIdSchema,
  harnessId: stableSidebarIdSchema,
  harnessName: z.string().trim().min(1).max(256),
  directoryStatus: sidebarDirectoryStatusSchema,
  icon: harnessIconResolutionSchema,
  title: z.string().trim().min(1).max(256),
  activity: sidebarActivitySchema,
  freshness: sidebarFreshnessSchema,
  recentOutcome: sidebarRecentOutcomeSchema,
  unread: z.boolean(),
  pendingInteractionCount: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  kind: sidebarSessionKindSchema,
  attention: sidebarAttentionSchema,
});
export type SidebarSessionRow = z.infer<typeof sidebarSessionRowSchema>;

export const sidebarAggregateSchema = z.strictObject({
  /** All hierarchy rows, including archived/internal/terminal rows, for stable diagnostics. */
  sessionCount: z.number().int().nonnegative(),
  /** Non-archived top-level Agent sessions only. */
  agentCount: z.number().int().nonnegative(),
  pendingInteractionCount: z.number().int().nonnegative(),
  runningCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  attention: sidebarAttentionSchema,
});
export type SidebarAggregate = z.infer<typeof sidebarAggregateSchema>;

export const sidebarWorkspaceNodeSchema = z.strictObject({
  workspaceId: stableSidebarIdSchema,
  projectId: stableSidebarIdSchema,
  repositoryBindingId: stableSidebarIdSchema.nullable(),
  targetId: stableSidebarIdSchema.nullable(),
  targetFreshness: sidebarFreshnessSchema,
  targetLabel: z.string().trim().min(1).max(256).optional(),
  targetKind: z.enum(["local", "ssh", "wsl", "docker", "unknown"]).optional(),
  verification: z.enum(["verified", "needsVerification"]).optional(),
  title: z.string().trim().min(1).max(256),
  // Offline Catalog rows deliberately have no execution path or Git facts.
  worktreePath: z.string().min(1).max(4096).nullable(),
  head: worktreeWorkspaceSchema.shape.head.nullable(),
  isMainWorktree: z.boolean().nullable(),
  lifecycle: z.enum(["active", "archived", "missing", "removed"]).nullable(),
  sessions: z.array(sidebarSessionRowSchema),
  summary: sidebarAggregateSchema,
});
export type SidebarWorkspaceNode = z.infer<typeof sidebarWorkspaceNodeSchema>;

export const sidebarProjectNodeSchema = z
  .strictObject({
    projectId: stableSidebarIdSchema,
    name: z.string().trim().min(1).max(256),
    iconAssetId: stableSidebarIdSchema.optional(),
    defaultWorkspaceId: stableSidebarIdSchema.optional(),
    defaultWorkspaceTargetId: stableSidebarIdSchema.optional(),
    workspaces: z.array(sidebarWorkspaceNodeSchema),
    summary: sidebarAggregateSchema,
  })
  .superRefine((project, context) => {
    if (project.defaultWorkspaceTargetId && !project.defaultWorkspaceId) {
      context.addIssue({
        code: "custom",
        path: ["defaultWorkspaceTargetId"],
        message: "default-workspace-target-without-workspace",
      });
      return;
    }
    if (
      project.defaultWorkspaceId &&
      project.defaultWorkspaceTargetId &&
      !project.workspaces.some(
        (workspace) =>
          workspace.workspaceId === project.defaultWorkspaceId &&
          workspace.targetId === project.defaultWorkspaceTargetId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["defaultWorkspaceTargetId"],
        message: "invalid-default-workspace-target",
      });
    }
  });
export type SidebarProjectNode = z.infer<typeof sidebarProjectNodeSchema>;

export const sidebarSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projects: z.array(sidebarProjectNodeSchema),
});
export type SidebarSnapshot = z.infer<typeof sidebarSnapshotSchema>;

/** Keep the attention order explicit and independent from row ordering. */
export function resolveSidebarAttention(
  summary: Pick<
    SidebarSessionRuntimeSummary,
    "activity" | "recentOutcome" | "unread" | "pendingInteractionCount"
  >,
): SidebarAttention {
  if (summary.pendingInteractionCount > 0) return "pending";
  if (summary.recentOutcome === "failed") return "error";
  if (summary.recentOutcome === "unknown" || summary.activity === "unknown") return "unknown";
  if (["starting", "running", "waiting", "cancelling"].includes(summary.activity)) return "running";
  if (summary.unread) return "unread";
  return "idle";
}
