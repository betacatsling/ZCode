import { basename } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { RepositoryBinding, WorktreeWorkspace } from "./planTypes.js";
import {
  createLinkedWorkspace,
  workspaceRecord,
  type CreateWorkspaceInput,
} from "./createLinkedWorkspace.js";
import { ProjectWorkspaceError } from "./errors.js";
import { discoverRepository, sameEvidence } from "./discovery.js";
import type { ProjectWorkspaceDeps } from "./ports.js";
import { resolveRepositoryBinding } from "./repositoryBindingResolver.js";
import type { CatalogSnapshot } from "./snapshot.js";

const logger = createServiceLogger("project-workspaces");

export type AdoptResult =
  | { status: "adopted" | "already-present"; binding: RepositoryBinding; workspace: WorktreeWorkspace }
  | { status: "needs-verification"; workspaceId: string; binding: RepositoryBinding };

function withBinding(snapshot: CatalogSnapshot, binding: RepositoryBinding): CatalogSnapshot {
  const exists = snapshot.bindings.some((item) => item.id === binding.id);
  return {
    ...snapshot,
    bindings: exists
      ? snapshot.bindings.map((item) => (item.id === binding.id ? binding : item))
      : [...snapshot.bindings, binding],
  };
}

export function createWorkspaceCommands(deps: ProjectWorkspaceDeps) {
  return {
    discover: (inputPath: string) => discoverRepository(deps, inputPath),
    async listWorkspaces(projectId?: string): Promise<WorktreeWorkspace[]> {
      const snapshot = await deps.store.read();
      return projectId
        ? snapshot.workspaces.filter((workspace) => workspace.projectId === projectId)
        : snapshot.workspaces;
    },
    async adopt(input: {
      projectId: string;
      worktreePath: string;
      title?: string;
      workspaceIdentity?: string;
    }): Promise<AdoptResult> {
      const report = await discoverRepository(deps, input.worktreePath);
      if (report.kind !== "git" && report.kind !== "bare") {
        throw new ProjectWorkspaceError(report.kind === "folder" ? "plain-folder" : report.kind);
      }
      const canonical = await deps.filesystem.realpath(input.worktreePath);
      const candidate = report.candidates.find((item) => item.worktreePath === canonical);
      if (!candidate) throw new ProjectWorkspaceError("candidate-not-found");
      const result = await deps.store.update<AdoptResult>((snapshot) => {
        if (!snapshot.projects.some((project) => project.id === input.projectId)) {
          throw new ProjectWorkspaceError("unknown-project");
        }
        const resolved = resolveRepositoryBinding({
          bindings: snapshot.bindings,
          projectId: input.projectId,
          executionTargetId: deps.executionTargetId,
          gitCommonDir: candidate.gitCommonDir,
          allocateId: deps.idFactory,
        });
        const owned = snapshot.workspaces.filter(
          (workspace) => workspace.repositoryBindingId === resolved.binding.id,
        );
        const sameInstance = owned.find((workspace) => {
          const evidence = snapshot.evidenceByWorkspaceId[workspace.id];
          return evidence ? sameEvidence(evidence, candidate.evidence) : false;
        });
        if (sameInstance) {
          if (sameInstance.lifecycle === "removed") {
            throw new ProjectWorkspaceError("removed-history-retained");
          }
          const workspace: WorktreeWorkspace = {
            ...sameInstance,
            worktreePath: candidate.worktreePath,
            head: candidate.head,
            isMainWorktree: candidate.isMainWorktree,
          };
          return {
            snapshot: {
              ...withBinding(snapshot, resolved.binding),
              workspaces: snapshot.workspaces.map((item) => (item.id === workspace.id ? workspace : item)),
              verificationByWorkspaceId: {
                ...snapshot.verificationByWorkspaceId,
                [workspace.id]: "verified",
              },
            },
            result: {
              status: "already-present" as const,
              binding: resolved.binding,
              workspace,
            },
          };
        }
        const samePath = owned.find(
          (workspace) =>
            workspace.worktreePath === candidate.worktreePath && workspace.lifecycle !== "removed",
        );
        const baseSnapshot = samePath
          ? {
              ...withBinding(snapshot, resolved.binding),
              verificationByWorkspaceId: {
                ...snapshot.verificationByWorkspaceId,
                [samePath.id]: "needsVerification" as const,
              },
            }
          : withBinding(snapshot, resolved.binding);
        const created = workspaceRecord(deps, {
          projectId: input.projectId,
          bindingId: resolved.binding.id,
          title: input.title || basename(candidate.worktreePath),
          candidate,
          origin: "adopted",
          workspaceIdentity: input.workspaceIdentity,
        });
        return {
          snapshot: {
            ...baseSnapshot,
            workspaces: [...baseSnapshot.workspaces, ...created.snapshotPatch.workspaces],
            evidenceByWorkspaceId: {
              ...baseSnapshot.evidenceByWorkspaceId,
              ...created.snapshotPatch.evidenceByWorkspaceId,
            },
            verificationByWorkspaceId: {
              ...baseSnapshot.verificationByWorkspaceId,
              ...created.snapshotPatch.verificationByWorkspaceId,
            },
            workspaceIdentityById: {
              ...baseSnapshot.workspaceIdentityById,
              ...created.snapshotPatch.workspaceIdentityById,
            },
          },
          result: { status: "adopted" as const, binding: resolved.binding, workspace: created.workspace },
        };
      });
      logger.info(undefined, "worktree-adopted", {
        status: result.status,
        workspaceId: "workspace" in result ? result.workspace.id : result.workspaceId,
      });
      return result;
    },
    async adoptBare(input: { projectId: string; inputPath: string }): Promise<RepositoryBinding> {
      const report = await discoverRepository(deps, input.inputPath);
      if (report.kind !== "bare") throw new ProjectWorkspaceError("not-bare-repository");
      const binding = await deps.store.update((snapshot) => {
        if (!snapshot.projects.some((project) => project.id === input.projectId)) {
          throw new ProjectWorkspaceError("unknown-project");
        }
        const resolved = resolveRepositoryBinding({
          bindings: snapshot.bindings,
          projectId: input.projectId,
          executionTargetId: deps.executionTargetId,
          gitCommonDir: report.gitCommonDir,
          allocateId: deps.idFactory,
        });
        return { snapshot: withBinding(snapshot, resolved.binding), result: resolved.binding };
      });
      logger.info(undefined, "bare-repository-bound", { bindingId: binding.id });
      return binding;
    },
    createWorkspace: (input: CreateWorkspaceInput) => createLinkedWorkspace(deps, input),
    async renameWorkspace(workspaceId: string, title: string): Promise<WorktreeWorkspace> {
      const trimmed = title.trim();
      if (!trimmed) throw new ProjectWorkspaceError("invalid-workspace");
      return deps.store.update((snapshot) => {
        const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
        if (!workspace) throw new ProjectWorkspaceError("unknown-workspace");
        const next = { ...workspace, title: trimmed };
        return {
          snapshot: {
            ...snapshot,
            workspaces: snapshot.workspaces.map((item) => (item.id === workspaceId ? next : item)),
          },
          result: next,
        };
      });
    },
    async setHidden(workspaceId: string, hidden: boolean): Promise<void> {
      await deps.store.update((snapshot) => {
        if (!snapshot.workspaces.some((workspace) => workspace.id === workspaceId)) {
          throw new ProjectWorkspaceError("unknown-workspace");
        }
        const hiddenWorkspaceIds = hidden
          ? snapshot.hiddenWorkspaceIds.includes(workspaceId)
            ? snapshot.hiddenWorkspaceIds
            : [...snapshot.hiddenWorkspaceIds, workspaceId]
          : snapshot.hiddenWorkspaceIds.filter((id) => id !== workspaceId);
        return { snapshot: { ...snapshot, hiddenWorkspaceIds }, result: undefined };
      });
    },
    async archiveWorkspace(workspaceId: string): Promise<WorktreeWorkspace> {
      return setLifecycle(deps, workspaceId, "archived");
    },
    async unarchiveWorkspace(workspaceId: string): Promise<WorktreeWorkspace> {
      return setLifecycle(deps, workspaceId, "active");
    },
  };
}

async function setLifecycle(
  deps: ProjectWorkspaceDeps,
  workspaceId: string,
  lifecycle: "active" | "archived",
): Promise<WorktreeWorkspace> {
  return deps.store.update((snapshot) => {
    const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new ProjectWorkspaceError("unknown-workspace");
    if (workspace.lifecycle === "removed" || workspace.lifecycle === "missing") {
      throw new ProjectWorkspaceError(`workspace-${workspace.lifecycle}`);
    }
    const next = { ...workspace, lifecycle };
    return {
      snapshot: {
        ...snapshot,
        workspaces: snapshot.workspaces.map((item) => (item.id === workspaceId ? next : item)),
      },
      result: next,
    };
  });
}

export function describeSharedWorkspace(): {
  files: "shared";
  gitDiffLabel: "工作区变更";
  attributesDiffToSession: false;
} {
  return { files: "shared", gitDiffLabel: "工作区变更", attributesDiffToSession: false };
}
