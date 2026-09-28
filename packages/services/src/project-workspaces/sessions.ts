import { isAbsolute, relative, resolve } from "node:path";
import type { AgentSessionRecord, WorktreeWorkspace } from "./planTypes.js";
import { ProjectWorkspaceError } from "./errors.js";
import { assertRelativeCwd, workspaceIdentityKey } from "./identity.js";
import type { ProjectWorkspaceDeps } from "./ports.js";
import type { CatalogSnapshot } from "./snapshot.js";

export interface ExecutionLocation {
  executionTargetId: string;
  workspaceId: string;
  worktreePath: string;
  worktreeGeneration: string;
  workspaceKey: string;
  cwdRelativeToWorktree: string | null;
  admissible: boolean;
  reason?: string;
}

export interface CreateAgentSessionInput {
  workspaceId: string;
  harnessId: string;
  title: string;
  cwdRelativeToWorktree?: string;
}

function executionOf(
  snapshot: CatalogSnapshot,
  session: AgentSessionRecord,
  serviceTargetId: string,
): ExecutionLocation {
  const workspace = snapshot.workspaces.find((item) => item.id === session.workspaceId);
  const binding = snapshot.bindings.find((item) => item.id === workspace?.repositoryBindingId);
  if (!workspace || !binding) throw new ProjectWorkspaceError("invalid-session");
  const cwd = snapshot.sessionCwdById[session.id] ?? null;
  const fence = snapshot.deletionByWorkspaceId[workspace.id];
  const verification = snapshot.verificationByWorkspaceId[workspace.id];
  let reason: string | undefined;
  if (fence) reason = "deletion-admission-rejected";
  else if (workspace.lifecycle !== "active") reason = `workspace-${workspace.lifecycle}`;
  else if (verification !== "verified") reason = "needs-verification";
  else if (binding.executionTargetId !== serviceTargetId) reason = "foreign-target";
  else if (snapshot.removedProjectIds.includes(workspace.projectId)) reason = "project-removed";
  else if (!cwd) reason = "cwd-not-recorded";
  return {
    executionTargetId: binding.executionTargetId,
    workspaceId: workspace.id,
    worktreePath: workspace.worktreePath,
    worktreeGeneration: workspace.worktreeGeneration,
    workspaceKey: workspaceIdentityKey({
      workspaceIdentity: snapshot.workspaceIdentityById[workspace.id],
      workspacePath: workspace.worktreePath,
    }),
    cwdRelativeToWorktree: cwd,
    admissible: reason === undefined,
    ...(reason ? { reason } : {}),
  };
}

async function checkedCwd(
  deps: ProjectWorkspaceDeps,
  workspace: WorktreeWorkspace,
  cwdRelativeToWorktree: string,
): Promise<string> {
  assertRelativeCwd(cwdRelativeToWorktree);
  const root = await deps.filesystem.realpath(workspace.worktreePath);
  const target =
    cwdRelativeToWorktree === "." ? root : await deps.filesystem.realpath(resolve(root, cwdRelativeToWorktree));
  const remainder = relative(root, target);
  if (remainder !== "" && (remainder.startsWith("..") || isAbsolute(remainder))) {
    throw new ProjectWorkspaceError("cwd-escapes-worktree");
  }
  return cwdRelativeToWorktree;
}

export function createSessionCommands(deps: ProjectWorkspaceDeps) {
  return {
    async listSessions(workspaceId: string): Promise<AgentSessionRecord[]> {
      const snapshot = await deps.store.read();
      return snapshot.sessions.filter((session) => session.workspaceId === workspaceId);
    },
    async readExecution(sessionId: string): Promise<ExecutionLocation> {
      const snapshot = await deps.store.read();
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) throw new ProjectWorkspaceError("unknown-session");
      return executionOf(snapshot, session, deps.executionTargetId);
    },
    async createAgentSession(input: CreateAgentSessionInput): Promise<{
      session: AgentSessionRecord;
      execution: ExecutionLocation;
    }> {
      const cwdRelative = input.cwdRelativeToWorktree ?? ".";
      const title = input.title?.trim();
      const harnessId = input.harnessId?.trim();
      if (!title || !harnessId) throw new ProjectWorkspaceError("invalid-session");
      const snapshot = await deps.store.read();
      const workspace = snapshot.workspaces.find((item) => item.id === input.workspaceId);
      if (!workspace) throw new ProjectWorkspaceError("unknown-workspace");
      await checkedCwd(deps, workspace, cwdRelative);
      return deps.store.update((current) => {
        const currentWorkspace = current.workspaces.find((item) => item.id === input.workspaceId);
        const binding = current.bindings.find((item) => item.id === currentWorkspace?.repositoryBindingId);
        if (!currentWorkspace || !binding) throw new ProjectWorkspaceError("unknown-workspace");
        if (binding.executionTargetId !== deps.executionTargetId) {
          throw new ProjectWorkspaceError("foreign-target");
        }
        if (current.deletionByWorkspaceId[currentWorkspace.id]) {
          throw new ProjectWorkspaceError("deletion-admission-rejected");
        }
        if (currentWorkspace.lifecycle !== "active") {
          throw new ProjectWorkspaceError(`workspace-${currentWorkspace.lifecycle}`);
        }
        if (current.verificationByWorkspaceId[currentWorkspace.id] !== "verified") {
          throw new ProjectWorkspaceError("needs-verification");
        }
        if (current.removedProjectIds.includes(currentWorkspace.projectId)) {
          throw new ProjectWorkspaceError("project-removed");
        }
        const session: AgentSessionRecord = {
          id: deps.idFactory(),
          workspaceId: currentWorkspace.id,
          harnessId,
          title,
        };
        const snapshotNext: CatalogSnapshot = {
          ...current,
          sessions: [...current.sessions, session],
          sessionCwdById: { ...current.sessionCwdById, [session.id]: cwdRelative },
        };
        return {
          snapshot: snapshotNext,
          result: { session, execution: executionOf(snapshotNext, session, deps.executionTargetId) },
        };
      });
    },
    async stopAgentSession(sessionId: string): Promise<{ stoppedSessionIds: readonly string[] }> {
      const snapshot = await deps.store.read();
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) throw new ProjectWorkspaceError("unknown-session");
      await deps.activity.stopSessions([session.id]);
      await deps.store.update((current) => ({
        snapshot: {
          ...current,
          stoppedSessionIds: current.stoppedSessionIds.includes(sessionId)
            ? current.stoppedSessionIds
            : [...current.stoppedSessionIds, sessionId],
        },
        result: undefined,
      }));
      return { stoppedSessionIds: [session.id] };
    },
    async noteViewDetached(sessionId: string): Promise<{ sessionRetained: true; workspaceRetained: true }> {
      const snapshot = await deps.store.read();
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) throw new ProjectWorkspaceError("unknown-session");
      if (!snapshot.workspaces.some((workspace) => workspace.id === session.workspaceId)) {
        throw new ProjectWorkspaceError("unknown-workspace");
      }
      return { sessionRetained: true, workspaceRetained: true };
    },
  };
}
