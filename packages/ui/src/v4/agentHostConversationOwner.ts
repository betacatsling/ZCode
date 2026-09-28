import type { SessionHierarchyRecord, SessionSpec } from "@zcode/shared/agent-host";
import type { RemoteTarget } from "@zcode/shared";

/** UI-derived owner route. SessionHierarchy and the Host summary remain authoritative. */
export interface AgentHostConversationOwnerLocator {
  readonly ownerKind: "agent-host";
  readonly hierarchySessionId: string;
  readonly ownerRecord: SessionHierarchyRecord;
  readonly sessionSpec: SessionSpec;
}

/** Existing target attachment; its live generation is read from the attached service. */
export interface AgentHostConversationAttachment extends AgentHostConversationOwnerLocator {
  readonly remoteSessionId: string | null;
  readonly remoteTarget?: RemoteTarget;
}

/** App-shell-only selection fence; this value never enters Host business state. */
export interface AgentHostConversationSelection extends AgentHostConversationAttachment {
  readonly selectionGeneration: number;
}

export function isValidAgentHostConversationOwner(
  locator: AgentHostConversationOwnerLocator,
): boolean {
  const { ownerRecord, sessionSpec } = locator;
  return (
    locator.ownerKind === "agent-host" &&
    ownerRecord.ownerKind === "agent-host" &&
    ownerRecord.status === "linked" &&
    ownerRecord.hierarchySessionId === locator.hierarchySessionId &&
    ownerRecord.nativeSessionId === sessionSpec.hostSessionId &&
    ownerRecord.targetId === sessionSpec.execution.targetId &&
    (!sessionSpec.execution.workspaceId ||
      ownerRecord.workspaceId === sessionSpec.execution.workspaceId) &&
    ownerRecord.harnessId === sessionSpec.harness.id &&
    ownerRecord.workspacePath === sessionSpec.execution.worktreePath &&
    (ownerRecord.workspaceIdentity ?? ownerRecord.workspacePath) ===
      (sessionSpec.execution.workspaceIdentity ?? sessionSpec.execution.worktreePath)
  );
}

export function agentHostConversationOwnerKey(
  selection: AgentHostConversationAttachment | AgentHostConversationSelection,
): string {
  const { ownerRecord, sessionSpec } = selection;
  return JSON.stringify([
    ownerRecord.targetId,
    selection.remoteSessionId,
    sessionSpec.execution.workspaceIdentity ?? sessionSpec.execution.worktreePath,
    sessionSpec.execution.workspaceId ?? null,
    sessionSpec.execution.worktreeGeneration ?? null,
    ownerRecord.workspacePath,
    ownerRecord.cwdRelativeToWorktree ?? null,
    ownerRecord.ownerKind,
    sessionSpec.harness.id,
    sessionSpec.harness.adapterVersion,
    sessionSpec.modelBinding,
    sessionSpec.hostSessionId,
    ownerRecord.hierarchySessionId,
    "selectionGeneration" in selection ? selection.selectionGeneration : null,
  ]);
}
