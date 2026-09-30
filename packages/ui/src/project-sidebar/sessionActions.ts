import {
  resolveWorkspaceAdmissionKey,
  type SessionHierarchyRecord,
  type WorkspaceSessionCreateRequest,
  type WorkspaceSessionOwnerLocator,
} from "@zcode/shared/agent-host";
import type { ProjectSidebarTargetOption, ProjectSidebarSessionAction } from "./contract.js";
import type { TargetServiceSource } from "./targetRefresh.js";
import { projectSidebarSessionViewKey } from "./viewKeys.js";

export type ProjectSidebarHistoryRoute =
  | {
      readonly status: "native";
      readonly action: Extract<ProjectSidebarSessionAction, { ownerKind: "native-v4" }>;
    }
  | {
      readonly status: "agent-host";
      readonly selection: {
        readonly ownerKind: "agent-host";
        readonly hierarchySessionId: string;
        readonly ownerRecord: SessionHierarchyRecord;
        readonly sessionSpec: import("@zcode/shared/agent-host").SessionSpec;
        readonly remoteSessionId: string | null;
        readonly remoteTarget?: import("@zcode/shared").RemoteTarget;
      };
    }
  | { readonly status: "waiting"; readonly reason: "target-offline" | "owner-unverified" };

function workspaceKey(identity: string | undefined, path: string): string {
  return resolveWorkspaceAdmissionKey(identity, path);
}

function matchingOwnerFact(
  owner: WorkspaceSessionOwnerLocator,
  record: SessionHierarchyRecord,
  association:
    | NonNullable<SessionHierarchyRecord["ownerAssociation"]>
    | NonNullable<SessionHierarchyRecord["ownerHistoryAssociation"]>,
  targetId: string,
): boolean {
  return (
    owner.ownerFactSource === "owner-index" &&
    owner.ownerKind === "agent-host" &&
    owner.targetId === targetId &&
    owner.sessionId === record.nativeSessionId &&
    owner.workspaceId === association.workspaceId &&
    owner.worktreeGeneration === association.worktreeGeneration &&
    owner.workspacePath === record.workspacePath &&
    owner.harnessId === record.harnessId &&
    workspaceKey(owner.workspaceIdentity, owner.workspacePath) ===
      workspaceKey(record.workspaceIdentity, record.workspacePath)
  );
}

export async function createProjectSidebarWorkspaceAgent(params: {
  target: ProjectSidebarTargetOption;
  workspaceId: string;
  worktreeGeneration: string;
  request: Pick<
    WorkspaceSessionCreateRequest,
    "requestId" | "harnessId" | "modelBinding" | "title"
  >;
  source: TargetServiceSource;
  isCurrentSource(source: TargetServiceSource): boolean;
  currentFreshness(targetId: string): "live" | "stale" | "offline" | "unknown" | undefined;
  refreshTarget(): Promise<void>;
  currentAction(hierarchySessionId: string): ProjectSidebarSessionAction | undefined;
}): Promise<ProjectSidebarSessionAction> {
  const { target, source, request } = params;
  const ensureCurrent = () => {
    if (!params.isCurrentSource(source) || params.currentFreshness(target.targetId) !== "live") {
      throw new Error("project-sidebar-stale-target-attachment");
    }
  };
  ensureCurrent();
  if (!target.writable || !source.available || !source.writable) {
    throw new Error("project-sidebar-target-unavailable");
  }
  const worktree = source.services.worktreeService;
  const agentHost = source.services.agentHostService;
  if (!worktree || !agentHost) throw new Error("project-sidebar-services-unavailable");

  const [availability, directory, worktreeCatalog] = await Promise.all([
    agentHost.getAvailability(),
    agentHost.getDirectory(),
    worktree.read(),
  ]);
  ensureCurrent();
  if (
    availability.target.id !== target.targetId ||
    !availability.target.available ||
    !availability.admissionEnabled ||
    !availability.harnesses.includes(request.harnessId) ||
    directory.targetId !== target.targetId ||
    directory.status !== "available" ||
    directory.entries.find((entry) => entry.manifest.id === request.harnessId)?.status !==
      "registered"
  ) {
    throw new Error("project-sidebar-target-unavailable");
  }
  const workspace = worktreeCatalog.workspaces.find((item) => item.id === params.workspaceId);
  if (
    !workspace ||
    workspace.worktreeGeneration !== params.worktreeGeneration ||
    workspace.lifecycle !== "active" ||
    workspace.verification !== "verified"
  ) {
    throw new Error("project-sidebar-stale-workspace-generation");
  }
  const evidence = await worktree.revalidate(workspace.id);
  ensureCurrent();
  if (
    evidence.status !== "verified" ||
    evidence.workspace.id !== workspace.id ||
    evidence.workspace.worktreeGeneration !== params.worktreeGeneration ||
    evidence.workspace.worktreePath !== workspace.worktreePath ||
    evidence.workspace.lifecycle !== "active"
  ) {
    throw new Error("project-sidebar-stale-workspace-generation");
  }

  const capability = await agentHost.getWorkspaceSessionCapability({
    harnessId: request.harnessId,
    modelBinding: request.modelBinding,
  });
  ensureCurrent();
  if (capability.targetId !== target.targetId || capability.report.support !== "supported") {
    throw new Error("project-sidebar-workspace-session-capability-unavailable");
  }

  const created = await agentHost.createWorkspaceSession({
    requestId: request.requestId,
    workspaceId: params.workspaceId,
    worktreeGeneration: params.worktreeGeneration,
    harnessId: request.harnessId,
    modelBinding: request.modelBinding,
    ...(request.title ? { title: request.title } : {}),
  });
  ensureCurrent();
  if (
    created.locator.targetId !== target.targetId ||
    created.locator.workspaceId !== params.workspaceId ||
    created.locator.worktreeGeneration !== params.worktreeGeneration ||
    created.locator.harnessId !== request.harnessId ||
    created.locator.workspacePath !== workspace.worktreePath
  ) {
    throw new Error("project-sidebar-created-owner-scope-mismatch");
  }

  const currentOwners = await agentHost.listWorkspaceSessionOwners({
    workspaceId: params.workspaceId,
    worktreeGeneration: params.worktreeGeneration,
  });
  ensureCurrent();
  const ownerFact = currentOwners.sessions.find(
    (owner) =>
      owner.ownerFactSource === "owner-index" &&
      owner.targetId === target.targetId &&
      owner.sessionId === created.locator.sessionId &&
      owner.workspaceId === params.workspaceId &&
      owner.worktreeGeneration === params.worktreeGeneration &&
      owner.workspacePath === workspace.worktreePath &&
      owner.harnessId === request.harnessId &&
      workspaceKey(owner.workspaceIdentity, owner.workspacePath) ===
        workspaceKey(created.locator.workspaceIdentity, created.locator.workspacePath),
  );
  if (!ownerFact) throw new Error("project-sidebar-created-owner-not-indexed");

  const hierarchyService = source.services.sessionHierarchyService;
  if (!hierarchyService) throw new Error("project-sidebar-services-unavailable");
  const hierarchy = await hierarchyService.read();
  ensureCurrent();
  const hierarchyRecord = hierarchy?.records.find(
    (record) =>
      record.nativeSessionId === created.locator.sessionId &&
      record.ownerKind === created.locator.ownerKind &&
      record.targetId === target.targetId &&
      record.status === "linked" &&
      record.workspaceId === params.workspaceId &&
      record.ownerAssociation?.workspaceId === params.workspaceId &&
      record.ownerAssociation.worktreeGeneration === params.worktreeGeneration &&
      record.workspacePath === workspace.worktreePath &&
      workspaceKey(record.workspaceIdentity, record.workspacePath) ===
        workspaceKey(created.locator.workspaceIdentity, created.locator.workspacePath),
  );
  if (!hierarchyRecord) throw new Error("project-sidebar-created-owner-not-linked");

  await params.refreshTarget();
  ensureCurrent();
  const action = params.currentAction(hierarchyRecord.hierarchySessionId);
  if (!action?.selectable || action.ownerKind !== created.locator.ownerKind) {
    throw new Error("project-sidebar-created-owner-not-projected");
  }
  if (
    action.targetId !== target.targetId ||
    action.attachmentGeneration !== target.attachmentGeneration ||
    action.workspacePath !== workspace.worktreePath
  ) {
    throw new Error("project-sidebar-created-owner-path-mismatch");
  }
  if (action.ownerKind === "native-v4" && action.nativeSessionId !== created.locator.sessionId) {
    throw new Error("project-sidebar-created-owner-id-mismatch");
  }
  if (
    action.ownerKind === "agent-host" &&
    (!action.ownerLocator ||
      action.ownerLocator.hierarchySessionId !== hierarchyRecord.hierarchySessionId ||
      action.ownerLocator.sessionSpec.hostSessionId !== created.locator.sessionId ||
      action.ownerLocator.sessionSpec.execution.worktreeGeneration !== params.worktreeGeneration)
  ) {
    throw new Error("project-sidebar-created-owner-locator-unavailable");
  }
  return action;
}

export async function openProjectSidebarHistoryRecord(params: {
  targetId: string;
  record: SessionHierarchyRecord;
  source: TargetServiceSource | undefined;
  isCurrentSource(source: TargetServiceSource): boolean;
  currentFreshness(targetId: string): "live" | "stale" | "offline" | "unknown" | undefined;
}): Promise<ProjectSidebarHistoryRoute> {
  const { record, source, targetId } = params;
  if (
    !source ||
    !source.available ||
    source.targetId !== targetId ||
    !params.isCurrentSource(source) ||
    params.currentFreshness(targetId) !== "live"
  ) {
    return { status: "waiting", reason: "target-offline" };
  }
  if (record.targetId !== targetId || !record.workspacePath) {
    return { status: "waiting", reason: "owner-unverified" };
  }
  if (record.ownerKind === "native-v4") {
    return {
      status: "native",
      action: {
        ownerKind: "native-v4",
        targetId,
        isLocal: source.kind === "local",
        attachmentGeneration: source.attachmentGeneration,
        remoteSessionId: source.remoteSessionId,
        ...(source.remoteTarget ? { remoteTarget: source.remoteTarget } : {}),
        nativeSessionId: record.nativeSessionId,
        workspacePath: record.workspacePath,
        ...(record.workspaceIdentity === undefined
          ? {}
          : { workspaceIdentity: record.workspaceIdentity }),
        selectable: true,
      },
    };
  }

  const association = record.ownerAssociation ?? record.ownerHistoryAssociation;
  const agentHost = source.services.agentHostService;
  if (!association || !record.workspaceId || !record.harnessId || !agentHost) {
    return { status: "waiting", reason: "owner-unverified" };
  }

  try {
    const ownerRead = await agentHost.listWorkspaceSessionOwners({
      workspaceId: association.workspaceId,
      worktreeGeneration: association.worktreeGeneration,
      ...(record.ownerHistoryAssociation ? { includeHistory: true } : {}),
    });
    if (!params.isCurrentSource(source)) return { status: "waiting", reason: "target-offline" };
    const owner = ownerRead.sessions.find((candidate) =>
      matchingOwnerFact(candidate, record, association, targetId),
    );
    if (!owner) return { status: "waiting", reason: "owner-unverified" };

    const identityKey = workspaceKey(record.workspaceIdentity, record.workspacePath);
    const summaries = await agentHost.listSessionSummaries(identityKey, record.workspacePath);
    if (!params.isCurrentSource(source)) return { status: "waiting", reason: "target-offline" };
    const summary = summaries.find(
      ({ spec }) =>
        spec.hostSessionId === owner.sessionId &&
        spec.execution.targetId === targetId &&
        spec.execution.workspaceId === association.workspaceId &&
        spec.execution.worktreeGeneration === association.worktreeGeneration &&
        spec.execution.worktreePath === record.workspacePath &&
        spec.execution.workspaceIdentity === identityKey &&
        spec.harness.id === record.harnessId,
    );
    if (!summary) return { status: "waiting", reason: "owner-unverified" };
    return {
      status: "agent-host",
      selection: {
        ownerKind: "agent-host",
        hierarchySessionId: record.hierarchySessionId,
        ownerRecord: record,
        sessionSpec: summary.spec,
        remoteSessionId: source.remoteSessionId,
        ...(source.remoteTarget ? { remoteTarget: source.remoteTarget } : {}),
      },
    };
  } catch {
    return { status: "waiting", reason: "target-offline" };
  }
}
