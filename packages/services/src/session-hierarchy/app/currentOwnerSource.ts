import type {
  WorkspaceSessionOwnerLocator,
  WorkspaceSessionOwnersRequest,
  WorkspaceSessionOwnersResult,
} from "@zcode/shared/agent-host";
import type { CurrentOwnerSessionIndexPort, LegacySessionLocator } from "../contract.js";

export interface WorkspaceSessionOwnerReader {
  listWorkspaceSessionOwners(
    request: WorkspaceSessionOwnersRequest,
  ): Promise<WorkspaceSessionOwnersResult>;
}

function toLocator(owner: WorkspaceSessionOwnerLocator): LegacySessionLocator {
  const selection =
    owner.modelBinding?.kind === "native-selection" || owner.modelBinding?.kind === "host-managed"
      ? owner.modelBinding.selection
      : undefined;
  const modelBindingKind =
    owner.modelBinding?.kind === "host-managed" || owner.modelBinding?.kind === "harness-managed"
      ? owner.modelBinding.kind
      : undefined;
  return {
    sourceKey:
      owner.ownerKind === "agent-host"
        ? `agent-host:${JSON.stringify([
            owner.targetId,
            owner.workspaceIdentity,
            owner.workspacePath,
            owner.harnessId,
            owner.sessionId,
          ])}`
        : `${owner.workspaceIdentity ?? owner.workspacePath}:${owner.sessionId}`,
    nativeSessionId: owner.sessionId,
    ownerKind: owner.ownerKind,
    targetId: owner.targetId,
    workspacePath: owner.workspacePath,
    cwd: owner.workspacePath,
    ...(owner.workspaceIdentity ? { workspaceIdentity: owner.workspaceIdentity } : {}),
    workspaceId: owner.workspaceId,
    worktreeGeneration: owner.worktreeGeneration,
    ...(owner.ownerFactSource ? { ownerFactSource: owner.ownerFactSource } : {}),
    harnessId: owner.harnessId,
    ...(owner.title ? { title: owner.title } : {}),
    ...(selection ? { modelSelection: selection } : {}),
    ...(modelBindingKind ? { modelBindingKind } : {}),
  };
}

/** Exact owner facts only; this source does not enumerate TaskIndex or inspect transcripts. */
export function createCurrentOwnerSessionSource(
  reader: WorkspaceSessionOwnerReader,
): CurrentOwnerSessionIndexPort {
  return {
    async listCurrentOwnerSessionLocators(workspaces) {
      const locators: LegacySessionLocator[] = [];
      for (const workspace of workspaces) {
        const result = await reader.listWorkspaceSessionOwners({
          workspaceId: workspace.workspaceId,
          worktreeGeneration: workspace.worktreeGeneration,
          includeHistory: true,
        });
        if (
          result.targetId !== workspace.targetId ||
          result.workspaceId !== workspace.workspaceId ||
          result.worktreeGeneration !== workspace.worktreeGeneration
        ) {
          throw new Error("managed-session-owner-scope-mismatch");
        }
        for (const owner of result.sessions) {
          if (
            owner.targetId !== workspace.targetId ||
            owner.workspaceId !== workspace.workspaceId
          ) {
            throw new Error("managed-session-owner-scope-mismatch");
          }
          locators.push(toLocator(owner));
        }
      }
      return locators;
    },
  };
}
