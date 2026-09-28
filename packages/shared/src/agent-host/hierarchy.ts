import { z } from "zod";
import {
  pathSchema,
  projectSchema,
  repositoryBindingSchema,
  stableIdSchema,
  worktreeWorkspaceSchema,
  type Project,
  type RepositoryBinding,
  type WorktreeWorkspace,
} from "../project-workspaces/index.js";
import {
  cwdRelativeToWorktreeSchema,
  executionTargetRefSchema,
  modelBindingRequestSchema,
  sessionSpecV2Schema,
  type ModelBindingRequest,
  type SessionSpecV2,
} from "./session-spec.js";

export {
  projectSchema,
  repositoryBindingSchema,
  worktreeWorkspaceSchema,
  type Project,
  type RepositoryBinding,
  type WorktreeWorkspace,
};

/**
 * A hierarchy session owns only its workspace association. Runtime state,
 * backend IDs and execution location remain in the existing session contracts.
 */
export const agentSessionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stableIdSchema,
  workspaceId: stableIdSchema,
  harnessId: stableIdSchema,
  title: z.string().trim().min(1).max(256),
  modelBinding: modelBindingRequestSchema.optional(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;
/** Plan §13.2 name. `id` is the host session identity, not a second session id. */
export type AgentSessionRecord = AgentSession;

const hierarchySnapshotBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projects: z.array(projectSchema),
  bindings: z.array(repositoryBindingSchema),
  workspaces: z.array(worktreeWorkspaceSchema),
  sessions: z.array(agentSessionSchema),
});
function addHierarchyInvariantIssues(
  snapshot: z.infer<typeof hierarchySnapshotBaseSchema>,
  context: z.RefinementCtx,
): void {
  const assertUniqueIds = (records: readonly { id: string }[], kind: string): void => {
    const seen = new Map<string, number>();
    records.forEach((record, index) => {
      const previousIndex = seen.get(record.id);
      if (previousIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: [kind === "project" ? "projects" : `${kind}s`, index, "id"],
          message: `duplicate-id:${kind}:${record.id}`,
        });
      } else {
        seen.set(record.id, index);
      }
    });
  };
  assertUniqueIds(snapshot.projects, "project");
  assertUniqueIds(snapshot.bindings, "binding");
  assertUniqueIds(snapshot.workspaces, "workspace");
  assertUniqueIds(snapshot.sessions, "session");

  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const bindings = new Map(snapshot.bindings.map((binding) => [binding.id, binding]));
  const workspaces = new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace]));

  for (const [index, project] of snapshot.projects.entries()) {
    const defaultWorkspace = project.defaultWorkspaceId
      ? workspaces.get(project.defaultWorkspaceId)
      : undefined;
    const defaultBinding = defaultWorkspace
      ? bindings.get(defaultWorkspace.repositoryBindingId)
      : undefined;
    if (
      project.defaultWorkspaceId &&
      (defaultWorkspace?.projectId !== project.id ||
        (project.defaultWorkspaceTargetId !== undefined &&
          defaultBinding?.executionTargetId !== project.defaultWorkspaceTargetId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["projects", index, "defaultWorkspaceTargetId"],
        message: `invalid-default-workspace:${project.id}`,
      });
    }
    if (!project.defaultWorkspaceId && project.defaultWorkspaceTargetId) {
      context.addIssue({
        code: "custom",
        path: ["projects", index, "defaultWorkspaceTargetId"],
        message: `default-workspace-target-without-workspace:${project.id}`,
      });
    }
  }
  for (const [index, binding] of snapshot.bindings.entries()) {
    if (!projects.has(binding.projectId)) {
      context.addIssue({
        code: "custom",
        path: ["bindings", index, "projectId"],
        message: `invalid-ownership:repository-binding:${binding.id}`,
      });
    }
  }
  for (const [index, workspace] of snapshot.workspaces.entries()) {
    if (
      !projects.has(workspace.projectId) ||
      bindings.get(workspace.repositoryBindingId)?.projectId !== workspace.projectId
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspaces", index],
        message: `invalid-ownership:workspace:${workspace.id}`,
      });
    }
  }
  for (const [index, session] of snapshot.sessions.entries()) {
    if (!workspaces.has(session.workspaceId)) {
      context.addIssue({
        code: "custom",
        path: ["sessions", index, "workspaceId"],
        message: `invalid-ownership:session:${session.id}`,
      });
    }
  }
}

/** The public schema includes cross-record ownership and uniqueness invariants. */
export const hierarchySnapshotSchema = hierarchySnapshotBaseSchema.superRefine(
  addHierarchyInvariantIssues,
);
export type HierarchySnapshot = z.infer<typeof hierarchySnapshotSchema>;

export interface HierarchyOwnership {
  readonly project: Project;
  readonly binding: RepositoryBinding;
  readonly workspace: WorktreeWorkspace;
  readonly session: AgentSession;
}

/**
 * Parse and validate the in-memory catalog projection. This checks schema,
 * references, and record uniqueness; it does not inspect Git or the target filesystem.
 */
export function parseHierarchySnapshot(value: unknown): HierarchySnapshot {
  return hierarchySnapshotSchema.parse(value);
}

export function resolveSessionOwnership(value: unknown, sessionId: string): HierarchyOwnership {
  const snapshot = parseHierarchySnapshot(value);
  const normalizedSessionId = stableIdSchema.parse(sessionId);
  const session = snapshot.sessions.find((candidate) => candidate.id === normalizedSessionId);
  if (!session) throw new Error(`unknown-session:${normalizedSessionId}`);
  const workspace = snapshot.workspaces.find((candidate) => candidate.id === session.workspaceId);
  if (!workspace) throw new Error(`invalid-ownership:session:${session.id}`);
  const project = snapshot.projects.find((candidate) => candidate.id === workspace.projectId);
  const binding = snapshot.bindings.find(
    (candidate) => candidate.id === workspace.repositoryBindingId,
  );
  if (!project || !binding) throw new Error(`invalid-ownership:workspace:${workspace.id}`);
  return { project, binding, workspace, session };
}

export { cwdRelativeToWorktreeSchema };

const executionSnapshotExecutionSchema = executionTargetRefSchema.extend({
  // The existing SessionSpec v1 keeps its legacy trimmed path behavior. The
  // independent hierarchy snapshot preserves target-owned paths exactly.
  workspaceIdentity: z.string().min(1).max(2048),
  worktreePath: pathSchema,
  worktreeGeneration: stableIdSchema,
  cwdRelativeToWorktree: cwdRelativeToWorktreeSchema,
});

/**
 * Independent, pure admission context derived from target-owned hierarchy facts.
 * It is intentionally separate from the existing SessionSpec v1 wire schema.
 */
export const executionSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: stableIdSchema,
  repositoryBindingId: stableIdSchema,
  workspaceId: stableIdSchema,
  sessionId: stableIdSchema,
  harnessId: stableIdSchema,
  execution: executionSnapshotExecutionSchema,
  modelBinding: modelBindingRequestSchema.optional(),
});
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

export interface DeriveExecutionSnapshotInput extends HierarchyOwnership {
  readonly cwdRelativeToWorktree?: string;
}

/**
 * Derive a fresh execution context. Session input contains no target/path/
 * generation fields; strict parsing therefore rejects attempts to override
 * target-owned identity instead of silently accepting a second authority.
 */
export function deriveExecutionSnapshot(input: DeriveExecutionSnapshotInput): ExecutionSnapshot {
  const project = projectSchema.parse(input.project);
  const binding = repositoryBindingSchema.parse(input.binding);
  const workspace = worktreeWorkspaceSchema.parse(input.workspace);
  const session = agentSessionSchema.parse(input.session);
  if (
    workspace.projectId !== project.id ||
    workspace.repositoryBindingId !== binding.id ||
    binding.projectId !== project.id ||
    session.workspaceId !== workspace.id
  ) {
    throw new Error("invalid-hierarchy-ownership");
  }
  if (workspace.lifecycle !== "active" || workspace.verification !== "verified") {
    throw new Error("workspace-not-admissible");
  }

  const workspaceIdentity = workspace.workspaceIdentity?.trim() || workspace.worktreePath;
  const cwdRelativeToWorktree = cwdRelativeToWorktreeSchema.parse(
    input.cwdRelativeToWorktree ?? ".",
  );
  return executionSnapshotSchema.parse({
    schemaVersion: 1,
    projectId: project.id,
    repositoryBindingId: binding.id,
    workspaceId: workspace.id,
    sessionId: session.id,
    harnessId: session.harnessId,
    execution: {
      targetId: binding.executionTargetId,
      workspaceIdentity,
      worktreePath: workspace.worktreePath,
      worktreeGeneration: workspace.worktreeGeneration,
      cwdRelativeToWorktree,
    },
    ...(session.modelBinding ? { modelBinding: session.modelBinding } : {}),
  });
}

export interface BuildSessionSpecV2Input extends HierarchyOwnership {
  readonly adapterVersion: string;
  readonly modelBinding: ModelBindingRequest;
  readonly cwdRelativeToWorktree?: string;
}

/**
 * Plan §4 spec. `hostSessionId` is `AgentSession.id`; callers cannot supply a
 * second session id or override the target derived from the repository binding.
 */
export function buildSessionSpecV2(input: BuildSessionSpecV2Input): SessionSpecV2 {
  const derived = deriveExecutionSnapshot(input);
  return sessionSpecV2Schema.parse({
    schemaVersion: 2,
    hostSessionId: input.session.id,
    projectId: derived.projectId,
    workspaceId: derived.workspaceId,
    execution: {
      targetId: derived.execution.targetId,
      workspaceIdentity: derived.execution.workspaceIdentity,
      worktreePath: derived.execution.worktreePath,
      worktreeGeneration: derived.execution.worktreeGeneration,
      cwdRelativeToWorktree: derived.execution.cwdRelativeToWorktree,
    },
    harness: { id: input.session.harnessId, adapterVersion: input.adapterVersion },
    modelBinding: input.modelBinding,
  });
}
