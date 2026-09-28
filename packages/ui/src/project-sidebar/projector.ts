import {
  parseHierarchySnapshot,
  projectSchema,
  repositoryBindingSchema,
  sidebarSessionRuntimeSummarySchema,
  type AgentSession,
  type HarnessDirectorySnapshot,
  type HierarchySnapshot,
  type SidebarSessionRuntimeSummary,
  type SidebarSnapshot,
  type SessionHierarchyFile,
  type WorktreeWorkspace,
} from "@zcode/shared/agent-host";
import { projectSidebarSnapshot } from "@zcode/services";
import type { ProjectCatalogFile } from "@zcode/services/project-catalog";
import type { WorktreeCatalogFile } from "@zcode/services/worktree";
import type { AgentHostSessionSummary } from "@zcode/shared/agent-host";
import type { RemoteTarget } from "@zcode/shared";
import type {
  ProjectSidebarNativeSessionMetadata,
  ProjectSidebarSessionAction,
  ProjectSidebarTargetViewModel,
} from "./contract.js";

function toHierarchySnapshot(
  catalog: ProjectCatalogFile,
  worktrees: WorktreeCatalogFile,
  targetId: string,
  migration: SessionHierarchyFile | null,
  summaries: readonly AgentHostSessionSummary[],
  nativeSessionMetadata: ReadonlyMap<string, ProjectSidebarNativeSessionMetadata>,
): HierarchySnapshot {
  const projects = catalog.projects.map((project) =>
    projectSchema.parse({
      schemaVersion: 1,
      id: project.id,
      name: project.name,
      ...(project.iconAssetId ? { iconAssetId: project.iconAssetId } : {}),
      ...(project.defaultWorkspaceId &&
      project.defaultWorkspaceTargetId === targetId &&
      worktrees.workspaces.some(
        (workspace) =>
          workspace.id === project.defaultWorkspaceId && workspace.projectId === project.id,
      )
        ? { defaultWorkspaceId: project.defaultWorkspaceId }
        : {}),
    }),
  );
  const bindings = worktrees.bindings.map((binding) =>
    repositoryBindingSchema.parse({
      schemaVersion: 1,
      id: binding.id,
      projectId: binding.projectId,
      executionTargetId: binding.executionTargetId,
      gitCommonDir: binding.gitCommonDir,
    }),
  );
  const workspaces = worktrees.workspaces.map((workspace): WorktreeWorkspace => {
    const { filesystemEvidence: _filesystemEvidence, ...record } = workspace;
    return record;
  });
  const sessions: AgentSession[] = (migration?.records ?? [])
    .filter((record) => record.workspaceId && record.harnessId)
    .map((record) => {
      const summary =
        record.ownerKind === "agent-host" ? findHostSummary(record, summaries) : undefined;
      return {
        schemaVersion: 1 as const,
        id: record.hierarchySessionId,
        workspaceId: record.workspaceId!,
        harnessId: record.harnessId!,
        title:
          nativeSessionMetadata.get(record.hierarchySessionId)?.title.trim() ||
          summary?.title.trim() ||
          record.nativeSessionId,
        ...(record.modelSelection
          ? { modelBinding: { kind: "host-managed" as const, selection: record.modelSelection } }
          : {}),
      };
    });
  return parseHierarchySnapshot({ schemaVersion: 1, projects, bindings, workspaces, sessions });
}

function directoryFromSnapshot(snapshot: HarnessDirectorySnapshot) {
  const entries = snapshot.entries.map((entry) => ({
    manifest: entry.manifest,
    status: entry.status,
    source: entry.source,
  }));
  return {
    list: () => entries,
    get: (id: string) => entries.find((entry) => entry.manifest.id === id),
  };
}

function defaultSummary(
  sessionId: string,
  workspaceId: string,
  freshness: SidebarSessionRuntimeSummary["freshness"] = "unknown",
  updatedAt = 0,
): SidebarSessionRuntimeSummary {
  return sidebarSessionRuntimeSummarySchema.parse({
    sessionId,
    workspaceId,
    activity: "unknown",
    freshness,
    // 缺失 Host summary 不能证明 session 从未有 turn；显式 none 仍由 summary 原样提供。
    recentOutcome: "unknown",
    unread: false,
    pendingInteractionCount: 0,
    updatedAt,
    archived: false,
    kind: "top-level",
  });
}

function workspaceIdentityForRecord(record: SessionHierarchyFile["records"][number]): string {
  // SessionHierarchy 持久化的是 Host 的 canonical key；trim 会把不同 owner 错并到同一 workspace。
  return record.workspaceIdentity ?? record.workspacePath ?? "";
}

function findHostSummary(
  record: SessionHierarchyFile["records"][number],
  summaries: readonly AgentHostSessionSummary[],
): AgentHostSessionSummary | undefined {
  return summaries.find(
    (summary) =>
      summary.spec.hostSessionId === record.nativeSessionId &&
      summary.spec.execution.targetId === record.targetId &&
      (summary.spec.execution.workspaceIdentity ?? summary.spec.execution.worktreePath) ===
        workspaceIdentityForRecord(record) &&
      summary.spec.execution.worktreePath === record.workspacePath &&
      (!summary.spec.execution.workspaceId ||
        summary.spec.execution.workspaceId === record.workspaceId) &&
      summary.spec.harness.id === (record.harnessId ?? ""),
  );
}

function summaryForRecord(
  record: SessionHierarchyFile["records"][number],
  workspaceId: string,
  summaries: readonly AgentHostSessionSummary[],
  targetFreshness: ReadonlyMap<string, SidebarSessionRuntimeSummary["freshness"]>,
  nativeSessionMetadata: ReadonlyMap<string, ProjectSidebarNativeSessionMetadata>,
): SidebarSessionRuntimeSummary {
  const hostSummary = record.ownerKind === "agent-host" ? findHostSummary(record, summaries) : null;
  if (!hostSummary) {
    return defaultSummary(
      record.hierarchySessionId,
      workspaceId,
      targetFreshness.get(record.targetId) ?? "unknown",
      record.ownerKind === "native-v4"
        ? (nativeSessionMetadata.get(record.hierarchySessionId)?.updatedAt ?? 0)
        : 0,
    );
  }
  const activity =
    hostSummary.lastKnownStatus === "running"
      ? "running"
      : hostSummary.lastKnownStatus === "waiting"
        ? "waiting"
        : hostSummary.lastKnownStatus === "starting"
          ? "starting"
          : hostSummary.lastKnownStatus === "cancelling"
            ? "cancelling"
            : hostSummary.lastKnownStatus === "idle" || hostSummary.lastKnownStatus === "completed"
              ? "idle"
              : "unknown";
  return sidebarSessionRuntimeSummarySchema.parse({
    sessionId: record.hierarchySessionId,
    workspaceId,
    activity,
    freshness: hostSummary.freshness,
    recentOutcome: hostSummary.recentOutcome,
    unread: hostSummary.unread,
    pendingInteractionCount: hostSummary.pendingInteractionCount,
    updatedAt: hostSummary.updatedAt,
    archived: hostSummary.archived,
    kind: hostSummary.kind,
  });
}

export function buildProjectSidebarViewModel(input: {
  catalog: ProjectCatalogFile;
  worktrees: WorktreeCatalogFile;
  migration: SessionHierarchyFile | null;
  directory: HarnessDirectorySnapshot;
  summaries: readonly AgentHostSessionSummary[];
  nativeSessionMetadata?: ReadonlyMap<string, ProjectSidebarNativeSessionMetadata>;
  appearance: "light" | "dark";
  targetId?: string;
  isLocal?: boolean;
  attachmentGeneration?: number;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget;
  targetFreshness?: ReadonlyMap<string, SidebarSessionRuntimeSummary["freshness"]>;
  targetWritable?: boolean;
}): ProjectSidebarTargetViewModel {
  const nativeSessionMetadata = input.nativeSessionMetadata ?? new Map();
  const targetId =
    input.targetId ?? input.worktrees.bindings[0]?.executionTargetId ?? "unknown-target";
  const rawHierarchy = toHierarchySnapshot(
    input.catalog,
    input.worktrees,
    targetId,
    input.migration,
    input.summaries,
    nativeSessionMetadata,
  );
  const hierarchyWithTitles = parseHierarchySnapshot({
    ...rawHierarchy,
    sessions: rawHierarchy.sessions.map((session) => {
      const record = input.migration?.records.find(
        (candidate) => candidate.hierarchySessionId === session.id,
      );
      const summary =
        record?.ownerKind === "agent-host" ? findHostSummary(record, input.summaries) : undefined;
      return summary?.title ? { ...session, title: summary.title } : session;
    }),
  });
  const targetFreshness = new Map<string, SidebarSessionRuntimeSummary["freshness"]>(
    input.targetFreshness ?? [],
  );
  for (const summary of input.summaries) {
    const current = targetFreshness.get(summary.spec.execution.targetId);
    if (summary.freshness === "live" || !current) {
      targetFreshness.set(summary.spec.execution.targetId, summary.freshness);
    }
  }
  const hierarchy = hierarchyWithTitles;
  const summaries = hierarchy.sessions.map((session) => {
    const record = input.migration?.records.find(
      (candidate) => candidate.hierarchySessionId === session.id,
    );
    return record
      ? summaryForRecord(
          record,
          session.workspaceId,
          input.summaries,
          targetFreshness,
          nativeSessionMetadata,
        )
      : defaultSummary(session.id, session.workspaceId);
  });
  const snapshot: SidebarSnapshot = projectSidebarSnapshot({
    hierarchy,
    summaries,
    directory: directoryFromSnapshot(input.directory),
    appearance: input.appearance,
    targetFreshness,
  });
  const sessionActions = new Map<string, ProjectSidebarSessionAction>();
  for (const record of input.migration?.records ?? []) {
    const isLinked =
      record.status === "linked" &&
      Boolean(record.workspaceId && record.harnessId && record.workspacePath);
    if (record.ownerKind === "native-v4") {
      sessionActions.set(record.hierarchySessionId, {
        ownerKind: "native-v4",
        targetId,
        isLocal: input.isLocal ?? false,
        attachmentGeneration: input.attachmentGeneration ?? 0,
        remoteSessionId: input.remoteSessionId ?? null,
        ...(input.remoteTarget ? { remoteTarget: input.remoteTarget } : {}),
        nativeSessionId: record.nativeSessionId,
        workspacePath: record.workspacePath ?? null,
        ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
        selectable: isLinked,
        ...(isLinked ? {} : { reason: record.pendingReason ?? "needs-verification" }),
      });
      continue;
    }
    const mapped = isLinked ? findHostSummary(record, input.summaries) : undefined;
    sessionActions.set(record.hierarchySessionId, {
      ownerKind: "agent-host",
      targetId,
      isLocal: input.isLocal ?? false,
      attachmentGeneration: input.attachmentGeneration ?? 0,
      remoteSessionId: input.remoteSessionId ?? null,
      ...(input.remoteTarget ? { remoteTarget: input.remoteTarget } : {}),
      ...(mapped
        ? {
            ownerLocator: {
              ownerKind: "agent-host",
              hierarchySessionId: record.hierarchySessionId,
              ownerRecord: record,
              sessionSpec: mapped.spec,
            },
          }
        : {}),
      workspacePath: record.workspacePath ?? null,
      ...(record.workspaceIdentity ? { workspaceIdentity: record.workspaceIdentity } : {}),
      selectable: Boolean(mapped),
      ...(mapped ? {} : { reason: record.pendingReason ?? "external-session-mapping-unavailable" }),
    });
  }
  return {
    source: {
      ...input,
      hierarchy,
      targetFreshness,
      nativeSessionMetadata,
      targetWritable: input.targetWritable ?? true,
    },
    snapshot,
    sessionActions,
  };
}
