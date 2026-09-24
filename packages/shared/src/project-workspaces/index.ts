import { z } from "zod";
import { iconAssetIdSchema } from "../agent-host/harness-plugin.js";

const id = z.string().trim().min(1).max(256);
const path = z.string().min(1).max(4096);
export const projectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  name: z.string().trim().min(1),
  sortOrder: z.number().int().nonnegative(),
  pinned: z.boolean().optional(),
  hidden: z.boolean().optional(),
  archived: z.boolean().optional(),
  iconAssetId: iconAssetIdSchema.optional(),
  defaultWorkspaceId: id.optional(),
});
export type Project = z.infer<typeof projectSchema>;
export const repositoryBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  projectId: id,
  executionTargetId: id,
  gitCommonDir: path,
});
export type RepositoryBinding = z.infer<typeof repositoryBindingSchema>;
export const worktreeWorkspaceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  projectId: id,
  repositoryBindingId: id,
  title: z.string().trim().min(1),
  sortOrder: z.number().int().nonnegative(),
  hidden: z.boolean(),
  archived: z.boolean().optional(),
  workspaceIdentity: z.string().trim().min(1).max(2048),
  worktreePath: path,
  worktreeGeneration: id,
  isMainWorktree: z.boolean(),
  head: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("branch"), ref: id, oid: z.string().min(1).nullable() }),
    z.strictObject({ kind: z.literal("detached"), oid: z.string().min(1) }),
  ]),
  origin: z.enum(["created", "adopted"]),
  lifecycle: z.enum(["active", "archived", "missing", "removed", "needsVerification"]),
});
export type WorktreeWorkspace = z.infer<typeof worktreeWorkspaceSchema>;
/** A target-verified discovery result is not yet a catalog workspace or permanent identity. */
export const unadoptedWorktreeCandidateSchema = worktreeWorkspaceSchema
  .pick({
    worktreePath: true,
    worktreeGeneration: true,
    isMainWorktree: true,
    head: true,
  })
  .extend({ repositoryBindingId: id, workspaceIdentity: z.string().trim().min(1).max(2048) });
export type UnadoptedWorktreeCandidate = z.infer<typeof unadoptedWorktreeCandidateSchema>;
export const agentSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  projectId: id,
  workspaceId: id,
  harnessId: id,
  title: z.string().trim().min(1),
  sortOrder: z.number().int().nonnegative(),
  archived: z.boolean(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const sessionSummarySchema = z.strictObject({
  session: agentSessionSchema,
  updatedAt: z.number().int().nonnegative(),
  activity: z.enum(["idle", "starting", "running", "waiting", "cancelling", "unknown"]),
  freshness: z.enum(["live", "stale", "offline", "unknown"]),
  lastTurn: z.enum(["succeeded", "failed", "cancelled", "unknown"]).optional(),
  unread: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const workspaceSummarySchema = z.strictObject({
  workspaceId: id,
  freshness: z.enum(["live", "stale", "offline", "unknown"]),
  totalAgents: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  unreadCompleted: z.number().int().nonnegative(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export const projectSummarySchema = z.strictObject({
  projectId: id,
  totalAgents: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  unreadCompleted: z.number().int().nonnegative(),
  attentionSessionIds: z.array(id),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export const sidebarSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Monotonic within one catalog owner epoch; clients refresh after reconnect. */
  revision: z.number().int().nonnegative().optional(),
  projects: z.array(projectSchema),
  bindings: z.array(repositoryBindingSchema),
  workspaces: z.array(worktreeWorkspaceSchema),
  sessions: z.array(sessionSummarySchema),
  workspaceSummaries: z.array(workspaceSummarySchema),
  projectSummaries: z.array(projectSummarySchema),
});
export type SidebarSnapshot = z.infer<typeof sidebarSnapshotSchema>;

/** Validate cross-record ownership and uniqueness; snapshot never defines the actual target filesystem. */
export function parseSidebarSnapshot(value: unknown): SidebarSnapshot {
  const snapshot = sidebarSnapshotSchema.parse(value);
  for (const records of [
    snapshot.projects,
    snapshot.bindings,
    snapshot.workspaces,
    snapshot.sessions.map(({ session }) => session),
  ]) {
    const ids = records.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate-id");
  }
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const bindings = new Map(snapshot.bindings.map((binding) => [binding.id, binding]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));
  for (const project of snapshot.projects)
    if (
      project.defaultWorkspaceId &&
      workspaces.get(project.defaultWorkspaceId)?.projectId !== project.id
    )
      throw new Error("invalid-ownership");
  for (const binding of snapshot.bindings)
    if (!projects.has(binding.projectId)) throw new Error("invalid-ownership");
  for (const workspace of snapshot.workspaces)
    if (
      !projects.has(workspace.projectId) ||
      bindings.get(workspace.repositoryBindingId)?.projectId !== workspace.projectId
    )
      throw new Error("invalid-ownership");
  for (const { session } of snapshot.sessions)
    if (workspaces.get(session.workspaceId)?.projectId !== session.projectId)
      throw new Error("invalid-ownership");
  if (
    snapshot.workspaceSummaries.length !== snapshot.workspaces.length ||
    new Set(snapshot.workspaceSummaries.map(({ workspaceId }) => workspaceId)).size !==
      snapshot.workspaces.length ||
    snapshot.projectSummaries.length !== snapshot.projects.length ||
    new Set(snapshot.projectSummaries.map(({ projectId }) => projectId)).size !==
      snapshot.projects.length
  )
    throw new Error("invalid-summary-identity");
  for (const summary of snapshot.workspaceSummaries) {
    if (!workspaces.has(summary.workspaceId)) throw new Error("invalid-summary-identity");
    const sessions = snapshot.sessions.filter(
      ({ session }) => session.workspaceId === summary.workspaceId && !session.archived,
    );
    if (
      summary.totalAgents !== sessions.length ||
      summary.waiting !== sessions.filter((s) => s.activity === "waiting").length ||
      summary.running !== sessions.filter((s) => s.activity === "running").length ||
      summary.errors !== sessions.filter((s) => s.lastTurn === "failed").length ||
      summary.unreadCompleted !==
        sessions.filter((s) => s.unread && s.lastTurn === "succeeded").length
    )
      throw new Error("invalid-summary-count");
  }
  for (const summary of snapshot.projectSummaries) {
    if (!projects.has(summary.projectId)) throw new Error("invalid-summary-identity");
    const sessions = snapshot.sessions.filter(
      ({ session }) => session.projectId === summary.projectId && !session.archived,
    );
    const attention = sessions
      .filter((s) => s.activity === "waiting" || s.lastTurn === "failed")
      .map((s) => s.session.id);
    if (
      summary.totalAgents !== sessions.length ||
      summary.waiting !== sessions.filter((s) => s.activity === "waiting").length ||
      summary.running !== sessions.filter((s) => s.activity === "running").length ||
      summary.errors !== sessions.filter((s) => s.lastTurn === "failed").length ||
      summary.unreadCompleted !==
        sessions.filter((s) => s.unread && s.lastTurn === "succeeded").length ||
      summary.attentionSessionIds.length !== attention.length ||
      new Set(summary.attentionSessionIds).size !== attention.length ||
      summary.attentionSessionIds.some((id) => !attention.includes(id))
    )
      throw new Error("invalid-summary-count");
  }
  return snapshot;
}

export const worktreeOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("discover"), repositoryBindingId: id }),
  z.strictObject({
    kind: z.literal("adopt"),
    repositoryBindingId: id,
    workspaceId: id,
    title: z.string().trim().min(1),
    worktreePath: path,
  }),
  z.strictObject({
    kind: z.literal("create"),
    repositoryBindingId: id,
    workspaceId: id,
    title: z.string().trim().min(1),
    baseRef: id,
    branch: id,
    worktreePath: path,
  }),
  z.strictObject({
    kind: z.literal("remove"),
    workspaceId: id,
    expectedGeneration: id,
    confirmation: z.literal(true),
  }),
]);
export type WorktreeOperation = z.infer<typeof worktreeOperationSchema>;
