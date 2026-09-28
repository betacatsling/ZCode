import type { Theme } from "@/useTheme.js";
import type {
  ProjectCatalogReadModel,
  IProjectCatalogService,
  ProjectCatalogTargetPresentation,
} from "@zcode/services/project-catalog";
import { resolveTheme } from "@/useTheme.js";
import { formatRemoteWorkspaceTargetSubtitle } from "@/lib/remoteWorkspaceHistory.js";
import { stripRemoteTargetSecrets, type RemoteTarget } from "@zcode/shared";
import type { WorkspaceServiceAttachment } from "@/hooks/useWorkspaceServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { buildProjectSidebarViewModel } from "./projector.js";
import type { ProjectSidebarTargetViewSnapshot } from "./contract.js";
import { readNativeSessionMetadata, workspaceKey } from "./readModel.js";

export interface TargetServiceSource extends WorkspaceServiceAttachment {
  readonly targetId: string;
  readonly available: boolean;
  readonly writable: boolean;
  readonly targetPresentation: ProjectCatalogTargetPresentation;
}

export function targetPresentationForAttachment(
  kind: WorkspaceServiceAttachment["kind"],
  target?: RemoteTarget,
): ProjectCatalogTargetPresentation {
  if (kind === "local") return { kind: "local" };
  if (!target) return { kind: "unknown" };
  const safeTarget = stripRemoteTargetSecrets(target);
  const configuredAlias = safeTarget.kind === "ssh" ? safeTarget.sshConfigAlias?.trim() : undefined;
  return {
    kind: safeTarget.kind,
    displayName: configuredAlias
      ? `SSH · ${configuredAlias}`
      : formatRemoteWorkspaceTargetSubtitle(safeTarget),
  };
}

export function catalogObservedAt(
  catalogFile: {
    targets: readonly {
      targetId: string;
      lastVerifiedAt: number | null;
      freshnessUpdatedAt: number | null;
    }[];
  },
  targetId: string,
  lastObservedAt: number,
): number {
  const current = catalogFile.targets.find((target) => target.targetId === targetId);
  return Math.max(
    Date.now(),
    lastObservedAt + 1,
    (current?.lastVerifiedAt ?? 0) + 1,
    (current?.freshnessUpdatedAt ?? 0) + 1,
  );
}

export function targetConnections(
  catalogFile: {
    targets: readonly { targetId: string }[];
    projects: readonly {
      repositoryReferences: readonly { targetId: string }[];
      workspaceReferences: readonly { targetId: string | null }[];
    }[];
  },
  sources: ReadonlyMap<string, TargetServiceSource>,
) {
  const targetIds = new Set(catalogFile.targets.map((target) => target.targetId));
  for (const project of catalogFile.projects) {
    for (const reference of project.repositoryReferences) targetIds.add(reference.targetId);
    for (const reference of project.workspaceReferences) {
      if (reference.targetId) targetIds.add(reference.targetId);
    }
  }
  for (const targetId of sources.keys()) targetIds.add(targetId);
  return [...targetIds].map((targetId) => ({
    targetId,
    state: sources.get(targetId)?.available ? ("connected" as const) : ("offline" as const),
  }));
}

export function isUnsupportedSidebarTargetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return ["unsupported", "not implemented", "unknown method", "method not found"].some((part) =>
    normalized.includes(part),
  );
}

export function sameAttachment(
  left: WorkspaceServiceAttachment,
  right: WorkspaceServiceAttachment,
): boolean {
  return (
    left.kind === right.kind &&
    left.services === right.services &&
    left.remoteSessionId === right.remoteSessionId &&
    left.attachmentGeneration === right.attachmentGeneration
  );
}

export async function refreshProjectSidebarTarget(params: {
  profileCatalog: IProjectCatalogService;
  source: TargetServiceSource;
  theme: Theme;
  targetViewsRef: { current: Map<string, ProjectSidebarTargetViewSnapshot> };
  targetObservedAtRef: { current: Map<string, number> };
  targetSourcesRef: { current: Map<string, TargetServiceSource> };
  isCurrentSource(source: TargetServiceSource): boolean;
  readProfileCatalog(): Promise<ProjectCatalogReadModel>;
  publishModel(readModel: ProjectCatalogReadModel, status?: "ready" | "refreshing"): void;
}): Promise<void> {
  const { profileCatalog, source } = params;
  if (!params.isCurrentSource(source)) return;
  const worktree = source.services.worktreeService;
  const hierarchy = source.services.sessionHierarchyService;
  const agentHost = source.services.agentHostService;
  if (!worktree || !hierarchy || !agentHost) {
    throw new Error("project-sidebar-services-unavailable");
  }
  const catalogBefore = await profileCatalog.read();
  if (!params.isCurrentSource(source)) return;
  const staleAt = catalogObservedAt(
    catalogBefore,
    source.targetId,
    params.targetObservedAtRef.current.get(source.targetId) ?? 0,
  );
  params.targetObservedAtRef.current.set(source.targetId, staleAt);
  // 连接代际变化时，连接本身不能把旧 Catalog 呈现重新标成 live。
  await profileCatalog.markTargetFreshness(source.targetId, "stale", staleAt);
  if (!params.isCurrentSource(source)) return;
  const afterStale = await profileCatalog.read();
  const staleRead = await profileCatalog.readWorkspaceCatalog(
    targetConnections(afterStale, params.targetSourcesRef.current),
  );
  if (params.isCurrentSource(source)) params.publishModel(staleRead, "refreshing");

  const availability = await worktree.getAvailability();
  if (!params.isCurrentSource(source)) return;
  if (availability.targetId !== source.targetId) {
    throw new Error("project-sidebar-target-scope-mismatch");
  }
  if (!availability.available) {
    const offlineAt = staleAt + 1;
    params.targetObservedAtRef.current.set(source.targetId, offlineAt);
    await profileCatalog.markTargetFreshness(source.targetId, "offline", offlineAt);
    if (!params.isCurrentSource(source)) return;
    params.publishModel(await params.readProfileCatalog());
    return;
  }

  const [worktrees, migrationRead, directory] = await Promise.all([
    worktree.read(),
    hierarchy.read(),
    agentHost.getDirectory(),
  ]);
  if (!params.isCurrentSource(source)) return;
  if (directory.status !== "available" || directory.targetId !== source.targetId) {
    throw new Error(
      directory.targetId !== source.targetId
        ? "project-sidebar-target-scope-mismatch"
        : "project-sidebar-harness-directory-unavailable",
    );
  }
  const migration = migrationRead ?? (await hierarchy.preview());
  const summarySettled = await Promise.allSettled(
    worktrees.workspaces.map((workspace) =>
      agentHost.listSessionSummaries(workspaceKey(workspace), workspace.worktreePath),
    ),
  );
  const summaries = [];
  const summaryFailures = new Map<string, "stale" | "offline">();
  for (const [index, result] of summarySettled.entries()) {
    const workspace = worktrees.workspaces[index];
    if (!workspace) continue;
    if (result.status === "fulfilled") summaries.push(...result.value);
    else {
      summaryFailures.set(
        workspace.id,
        isRemoteWorkspaceDisconnectedError(result.reason) ? "offline" : "stale",
      );
    }
  }
  const nativeSessionMetadata = await readNativeSessionMetadata({
    taskService: source.services.zcodeTaskService,
    worktrees,
    migration,
    targetId: source.targetId,
  });
  if (!params.isCurrentSource(source)) return;
  const catalogForProjection = await profileCatalog.read();
  const targetFreshness = new Map([[source.targetId, "live" as const]]);
  const targetModel = buildProjectSidebarViewModel({
    catalog: catalogForProjection,
    worktrees,
    migration,
    directory,
    summaries,
    nativeSessionMetadata,
    appearance: resolveTheme(params.theme),
    targetId: source.targetId,
    isLocal: source.kind === "local",
    attachmentGeneration: source.attachmentGeneration,
    remoteSessionId: source.remoteSessionId,
    remoteTarget: source.remoteTarget,
    targetFreshness,
    targetWritable: availability.writable,
  });
  const sessionSummaries = targetModel.snapshot.projects.flatMap((project) =>
    project.workspaces
      .filter((workspace) => !summaryFailures.has(workspace.workspaceId))
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        sessions: workspace.sessions,
        summary: workspace.summary,
      })),
  );
  const snapshotObservedAt = Math.max(staleAt + 1, Date.now());
  params.targetObservedAtRef.current.set(source.targetId, snapshotObservedAt);
  await profileCatalog.ingestTargetSnapshot({
    schemaVersion: 1,
    targetId: source.targetId,
    observedAt: snapshotObservedAt,
    targetPresentation: source.targetPresentation,
    bindings: worktrees.bindings.map(({ id, projectId, executionTargetId }) => ({
      id,
      projectId,
      executionTargetId,
    })),
    workspaces: worktrees.workspaces.map(
      ({
        id,
        projectId,
        repositoryBindingId,
        title,
        isMainWorktree,
        head,
        lifecycle,
        verification,
      }) => ({
        id,
        projectId,
        repositoryBindingId,
        title,
        isMainWorktree,
        head,
        lifecycle,
        verification,
      }),
    ),
    sessionSummaries,
  });
  if (!params.isCurrentSource(source)) return;
  params.targetViewsRef.current.set(source.targetId, {
    targetId: source.targetId,
    attachmentGeneration: source.attachmentGeneration,
    remoteSessionId: source.remoteSessionId,
    ...(source.remoteTarget ? { remoteTarget: source.remoteTarget } : {}),
    isLocal: source.kind === "local",
    targetPresentation: source.targetPresentation,
    targetWritable: availability.writable,
    summaryFailures,
    model: targetModel,
  });
  params.publishModel(await params.readProfileCatalog());
}
