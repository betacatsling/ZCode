import {
  parseHierarchySnapshot,
  resolveHarnessIcon,
  resolveSidebarAttention,
  sidebarSessionRuntimeSummarySchema,
  sidebarSnapshotSchema,
  type HierarchySnapshot,
  type SidebarAggregate,
  type SidebarSessionRuntimeSummary,
  type SidebarSnapshot,
  type SidebarSessionRow,
} from "@zcode/shared/agent-host";
import type { HarnessDirectory } from "../agent-host/harnessDirectory.js";

const UNKNOWN_SUMMARY = {
  activity: "unknown" as const,
  freshness: "unknown" as const,
  // 缺失 summary 只能表示历史未知；只有 Host 明确声明新 session 无 prior turn 才是 none。
  recentOutcome: "unknown" as const,
  unread: false,
  pendingInteractionCount: 0,
  updatedAt: 0,
  archived: false,
  kind: "top-level" as const,
};

function aggregate(rows: readonly SidebarSessionRow[]): SidebarAggregate {
  const counted = rows.filter((row) => !row.archived && row.kind === "top-level");
  const attention = counted.reduce<SidebarAggregate["attention"]>((current, row) => {
    const rank: Record<SidebarAggregate["attention"], number> = {
      pending: 0,
      error: 1,
      unknown: 2,
      running: 3,
      unread: 4,
      idle: 5,
    };
    return rank[row.attention] < rank[current] ? row.attention : current;
  }, "idle");
  return {
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
  };
}

function defaultSummary(sessionId: string, workspaceId: string): SidebarSessionRuntimeSummary {
  return sidebarSessionRuntimeSummarySchema.parse({
    sessionId,
    workspaceId,
    ...UNKNOWN_SUMMARY,
  });
}

export function projectSidebarSnapshot(input: {
  hierarchy: HierarchySnapshot | unknown;
  summaries: readonly SidebarSessionRuntimeSummary[];
  directory: HarnessDirectory;
  appearance: "light" | "dark";
  targetFreshness?: ReadonlyMap<string, SidebarSessionRuntimeSummary["freshness"]>;
}): SidebarSnapshot {
  const hierarchy = parseHierarchySnapshot(input.hierarchy);
  const summaryBySession = new Map<string, SidebarSessionRuntimeSummary>();
  for (const raw of input.summaries) {
    const summary = sidebarSessionRuntimeSummarySchema.parse(raw);
    if (summaryBySession.has(summary.sessionId))
      throw new Error(`duplicate sidebar summary: ${summary.sessionId}`);
    summaryBySession.set(summary.sessionId, summary);
  }
  const bindings = new Map(hierarchy.bindings.map((binding) => [binding.id, binding]));
  const projectNodes = hierarchy.projects.map((project) => {
    const workspaceNodes = hierarchy.workspaces
      .filter((workspace) => workspace.projectId === project.id)
      .map((workspace) => {
        const binding = bindings.get(workspace.repositoryBindingId)!;
        const rows = hierarchy.sessions
          .filter((session) => session.workspaceId === workspace.id)
          .map((session): SidebarSessionRow => {
            const summary =
              summaryBySession.get(session.id) ?? defaultSummary(session.id, workspace.id);
            if (summary.workspaceId !== workspace.id) {
              throw new Error(`sidebar summary workspace mismatch: ${session.id}`);
            }
            const entry = input.directory.get(session.harnessId);
            const manifest = entry?.manifest;
            return {
              sessionId: session.id,
              workspaceId: workspace.id,
              harnessId: session.harnessId,
              harnessName: manifest?.name ?? session.harnessId,
              directoryStatus: entry?.status ?? "unknown",
              icon: resolveHarnessIcon(manifest, input.appearance),
              title: session.title,
              activity: summary.activity,
              freshness: summary.freshness,
              recentOutcome: summary.recentOutcome,
              unread: summary.unread,
              pendingInteractionCount: summary.pendingInteractionCount,
              updatedAt: summary.updatedAt,
              archived: summary.archived,
              kind: summary.kind,
              attention: resolveSidebarAttention(summary),
            };
          });
        return {
          workspaceId: workspace.id,
          projectId: project.id,
          repositoryBindingId: workspace.repositoryBindingId,
          targetId: binding.executionTargetId,
          targetFreshness: input.targetFreshness?.get(binding.executionTargetId) ?? "unknown",
          title: workspace.title,
          worktreePath: workspace.worktreePath,
          head: workspace.head,
          isMainWorktree: workspace.isMainWorktree,
          lifecycle: workspace.lifecycle,
          sessions: rows,
          summary: aggregate(rows),
        };
      });
    const summary = aggregate(workspaceNodes.flatMap((workspace) => workspace.sessions));
    return {
      projectId: project.id,
      name: project.name,
      ...(project.iconAssetId ? { iconAssetId: project.iconAssetId } : {}),
      ...(project.defaultWorkspaceId ? { defaultWorkspaceId: project.defaultWorkspaceId } : {}),
      workspaces: workspaceNodes,
      summary,
    };
  });
  // Keep the hierarchy as the membership authority; stale summaries never add rows.
  return sidebarSnapshotSchema.parse({ schemaVersion: 1, projects: projectNodes });
}
