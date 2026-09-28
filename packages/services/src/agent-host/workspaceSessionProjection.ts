import type {
  SessionSpec,
  WorkspaceSessionModelBinding,
  WorkspaceSessionOwnerLocator,
} from "@zcode/shared/agent-host";
import type { ManagedWorkspaceSessionAssociation } from "@zcode/shared/agent-host";

export function workspaceSessionLocatorFromSpec(
  spec: SessionSpec,
  title?: string,
): WorkspaceSessionOwnerLocator {
  const workspaceIdentity =
    spec.execution.workspaceIdentity === spec.execution.worktreePath
      ? undefined
      : spec.execution.workspaceIdentity.trim();
  return {
    ownerKind: "agent-host",
    sessionId: spec.hostSessionId,
    targetId: spec.execution.targetId,
    workspaceId: spec.execution.workspaceId!,
    worktreeGeneration: spec.execution.worktreeGeneration!,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    workspacePath: spec.execution.worktreePath,
    harnessId: spec.harness.id,
    ...(title ? { title } : {}),
    modelBinding: spec.modelBinding,
  };
}

export function workspaceSessionLocatorFromNative(
  owner: {
    sessionId: string;
    association: ManagedWorkspaceSessionAssociation;
    workspacePath: string;
    workspaceIdentity?: string;
    title?: string;
  },
  modelBinding?: WorkspaceSessionModelBinding,
): WorkspaceSessionOwnerLocator {
  const workspaceIdentity =
    owner.workspaceIdentity === owner.workspacePath ? undefined : owner.workspaceIdentity?.trim();
  return {
    ownerKind: "native-v4",
    sessionId: owner.sessionId,
    targetId: owner.association.targetId,
    workspaceId: owner.association.workspaceId,
    worktreeGeneration: owner.association.worktreeGeneration,
    ...(workspaceIdentity && workspaceIdentity !== owner.workspacePath
      ? { workspaceIdentity }
      : {}),
    workspacePath: owner.workspacePath,
    harnessId: "zcode",
    ...(owner.title ? { title: owner.title } : {}),
    ...(modelBinding ? { modelBinding } : {}),
  };
}
