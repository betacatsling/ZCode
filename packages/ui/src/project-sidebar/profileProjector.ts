import {
  resolveSidebarAttention,
  sidebarAggregateSchema,
  sidebarSnapshotSchema,
  type SidebarAggregate,
  type SidebarProjectNode,
  type SidebarSessionRow,
  type SidebarSnapshot,
  type SidebarWorkspaceNode,
} from "@zcode/shared/agent-host";
import type { ProjectCatalogReadModel } from "@zcode/services/project-catalog";
import type { ProjectSidebarSessionAction, ProjectSidebarViewModel } from "./contract.js";
import { projectSidebarSessionViewKey } from "./viewKeys.js";

export function aggregateSidebarSessions(rows: readonly SidebarSessionRow[]): SidebarAggregate {
  const counted = rows.filter((row) => !row.archived && row.kind === "top-level");
  const rank: Record<SidebarAggregate["attention"], number> = {
    pending: 0,
    error: 1,
    unknown: 2,
    running: 3,
    unread: 4,
    idle: 5,
  };
  const attention = counted.reduce<SidebarAggregate["attention"]>(
    (current, row) =>
      rank[resolveSidebarAttention(row)] < rank[current] ? resolveSidebarAttention(row) : current,
    "idle",
  );
  return sidebarAggregateSchema.parse({
    sessionCount: rows.length,
    agentCount: counted.length,
    pendingInteractionCount: counted.reduce((sum, row) => sum + row.pendingInteractionCount, 0),
    runningCount: counted.filter((row) =>
      ["starting", "running", "waiting", "cancelling"].includes(row.activity),
    ).length,
    errorCount: counted.filter((row) => row.recentOutcome === "failed").length,
    unknownCount: counted.filter(
      (row) => row.recentOutcome === "unknown" || row.activity === "unknown",
    ).length,
    unreadCount: counted.filter((row) => row.unread).length,
    attention,
  });
}

function cachedWorkspaceNode(
  reference: ProjectCatalogReadModel["projects"][number]["workspaceReferences"][number],
  targetPresentation?: ProjectCatalogReadModel["targets"][number]["presentation"],
): SidebarWorkspaceNode {
  const presentation = reference.presentation;
  return {
    workspaceId: reference.workspaceId,
    projectId: reference.projectId,
    repositoryBindingId: reference.repositoryBindingId,
    targetId: reference.targetId,
    targetFreshness: reference.targetFreshness,
    ...(targetPresentation?.displayName ? { targetLabel: targetPresentation.displayName } : {}),
    ...(targetPresentation?.kind ? { targetKind: targetPresentation.kind } : {}),
    verification: reference.verification,
    title: presentation?.worktree.title ?? "Needs verification",
    worktreePath: null,
    head: presentation?.worktree.head ?? null,
    isMainWorktree: presentation?.worktree.isMainWorktree ?? null,
    lifecycle: presentation?.worktree.lifecycle ?? null,
    sessions: presentation?.sessionSummary?.sessions ?? [],
    summary: presentation?.sessionSummary?.summary ?? aggregateSidebarSessions([]),
  };
}

function workspaceSummaryWithFreshness(
  workspace: SidebarWorkspaceNode,
  freshness: "stale" | "offline" | "unknown",
): SidebarWorkspaceNode {
  return {
    ...workspace,
    targetFreshness: freshness,
    sessions: workspace.sessions.map((session) => ({ ...session, freshness })),
  };
}

export function buildProjectSidebarProfileViewModel(input: {
  catalog: ProjectCatalogReadModel;
  targets: ProjectSidebarViewModel["source"]["targets"];
  appearance: "light" | "dark";
}): ProjectSidebarViewModel {
  const targetFreshness = new Map(
    input.catalog.targets.map((target) => [target.targetId, target.freshness]),
  );
  const targetById = new Map(input.targets.map((target) => [target.targetId, target]));
  const sessionActions = new Map<string, ProjectSidebarSessionAction>();

  const projects = input.catalog.projects.map((project): SidebarProjectNode => {
    const workspaces = project.workspaceReferences.map((reference) => {
      const catalogTargetPresentation = reference.targetId
        ? input.catalog.targets.find((target) => target.targetId === reference.targetId)
            ?.presentation
        : undefined;
      if (reference.targetId === null) return cachedWorkspaceNode(reference);
      const target = targetById.get(reference.targetId);
      const isFreshTarget = reference.targetFreshness === "live" && target !== undefined;
      const targetProject = isFreshTarget
        ? target.model.snapshot.projects.find((item) => item.projectId === project.id)
        : undefined;
      const liveWorkspace = targetProject?.workspaces.find(
        (workspace) =>
          workspace.workspaceId === reference.workspaceId &&
          workspace.repositoryBindingId === reference.repositoryBindingId,
      );
      if (!liveWorkspace || !target)
        return cachedWorkspaceNode(reference, catalogTargetPresentation);

      const summaryFailure = target.summaryFailures.get(reference.workspaceId);
      const workspace = summaryFailure
        ? reference.presentation?.sessionSummary
          ? {
              ...liveWorkspace,
              sessions: reference.presentation.sessionSummary.sessions,
              summary: reference.presentation.sessionSummary.summary,
            }
          : workspaceSummaryWithFreshness(liveWorkspace, summaryFailure)
        : liveWorkspace;
      const previousSessions = reference.presentation?.sessionSummary?.sessions ?? [];
      const previousBySessionId = new Map(
        previousSessions.map((session) => [session.sessionId, session]),
      );
      const freshSessionIds = new Set(workspace.sessions.map((session) => session.sessionId));
      const mergedSessions = workspace.sessions.map((session) => {
        const previous = previousBySessionId.get(session.sessionId);
        if (!previous) return session;
        if (
          (session.activity === "unknown" && session.recentOutcome === "unknown") ||
          (session.recentOutcome === "unknown" && previous.recentOutcome !== "unknown")
        ) {
          return {
            ...previous,
            freshness: "stale" as const,
          };
        }
        return session;
      });
      for (const previous of previousSessions) {
        if (freshSessionIds.has(previous.sessionId)) continue;
        mergedSessions.push({ ...previous, freshness: "stale" });
      }
      const targetPresentation = target.targetPresentation ?? catalogTargetPresentation;
      const workspaceWithTargetLabel: SidebarWorkspaceNode = {
        ...workspace,
        sessions: mergedSessions,
        summary: aggregateSidebarSessions(mergedSessions),
        ...(targetPresentation?.displayName ? { targetLabel: targetPresentation.displayName } : {}),
        ...(targetPresentation?.kind ? { targetKind: targetPresentation.kind } : {}),
      };

      if (!summaryFailure) {
        for (const session of workspaceWithTargetLabel.sessions) {
          const action = target.model.sessionActions.get(session.sessionId);
          if (!action?.selectable) continue;
          sessionActions.set(
            projectSidebarSessionViewKey(target.targetId, workspace.workspaceId, session.sessionId),
            action,
          );
        }
      }
      return workspaceWithTargetLabel;
    });
    const projectSessions = workspaces.flatMap((workspace) => workspace.sessions);
    return {
      projectId: project.id,
      name: project.name,
      ...(project.iconAssetId ? { iconAssetId: project.iconAssetId } : {}),
      ...(project.defaultWorkspaceId ? { defaultWorkspaceId: project.defaultWorkspaceId } : {}),
      ...(project.defaultWorkspaceTargetId
        ? { defaultWorkspaceTargetId: project.defaultWorkspaceTargetId }
        : {}),
      workspaces,
      summary: aggregateSidebarSessions(projectSessions),
    };
  });

  const snapshot: SidebarSnapshot = sidebarSnapshotSchema.parse({ schemaVersion: 1, projects });
  return {
    source: { catalog: input.catalog, targets: input.targets, targetFreshness },
    snapshot,
    sessionActions,
  };
}
