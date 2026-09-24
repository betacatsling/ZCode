import { z } from "zod";
import { iconAssetIdSchema } from "../agent-host/harness-plugin.js";

const id = z.string().trim().min(1).max(256);
const path = z.string().min(1).max(4096);
export const projectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  name: z.string().trim().min(1),
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
  workspaceIdentity: id,
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
export const agentSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  projectId: id,
  workspaceId: id,
  harnessId: id,
  title: z.string().trim().min(1),
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
export const sidebarSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projects: z.array(projectSchema),
  bindings: z.array(repositoryBindingSchema),
  workspaces: z.array(worktreeWorkspaceSchema),
  sessions: z.array(sessionSummarySchema),
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
  return snapshot;
}

export const worktreeOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("discover"), repositoryBindingId: id }),
  z.strictObject({ kind: z.literal("adopt"), repositoryBindingId: id, worktreePath: path }),
  z.strictObject({
    kind: z.literal("create"),
    repositoryBindingId: id,
    baseRef: id,
    branch: id,
    worktreePath: path,
  }),
  z.strictObject({ kind: z.literal("remove"), workspaceId: id, expectedGeneration: id }),
]);
export type WorktreeOperation = z.infer<typeof worktreeOperationSchema>;
