import {
  parseSidebarSnapshot,
  type AgentSession,
  type Project,
  type RepositoryBinding,
  type SessionSummary,
  type SidebarSnapshot,
  type WorktreeWorkspace,
} from "@zcode/shared/project-workspaces";

/** Host supplies its entire top-level index, never a filtered/open-tab subset. */
export interface CatalogSessionIndex {
  /** Host index emits after a durable summary/freshness change; no UI focus command. */
  onChange?(listener: () => void): () => void;
  allSessions(): Promise<readonly SessionSummary[]>;
  workspaceFreshness(
    workspace: WorktreeWorkspace,
  ): Promise<"live" | "stale" | "offline" | "unknown">;
}

export function sidebarIndex(input: {
  projects: readonly Project[];
  bindings: readonly RepositoryBinding[];
  workspaces: readonly WorktreeWorkspace[];
  sessions: readonly SessionSummary[];
  freshness: ReadonlyMap<string, "live" | "stale" | "offline" | "unknown">;
  revision?: number;
}): SidebarSnapshot {
  const ordered = <T extends { id: string; sortOrder: number }>(rows: readonly T[]): T[] =>
    [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const projects = ordered(input.projects);
  const workspaces = ordered(input.workspaces);
  const sessions = [...input.sessions].sort(
    (a, b) => a.session.sortOrder - b.session.sortOrder || a.session.id.localeCompare(b.session.id),
  );
  const count = (rows: readonly SessionSummary[]) => ({
    totalAgents: rows.length,
    waiting: rows.filter((s) => s.activity === "waiting").length,
    running: rows.filter((s) => s.activity === "running").length,
    errors: rows.filter((s) => s.lastTurn === "failed").length,
    unreadCompleted: rows.filter((s) => s.unread && s.lastTurn === "succeeded").length,
  });
  const active = (predicate: (session: AgentSession) => boolean) =>
    sessions.filter(({ session }) => !session.archived && predicate(session));
  return parseSidebarSnapshot({
    schemaVersion: 1,
    revision: input.revision,
    projects,
    bindings: [...input.bindings],
    workspaces,
    sessions,
    workspaceSummaries: workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      freshness: input.freshness.get(workspace.id) ?? "unknown",
      ...count(active((session) => session.workspaceId === workspace.id)),
    })),
    projectSummaries: projects.map((project) => {
      const rows = active((session) => session.projectId === project.id);
      return {
        projectId: project.id,
        ...count(rows),
        attentionSessionIds: rows
          .filter((s) => s.activity === "waiting" || s.lastTurn === "failed")
          .map((s) => s.session.id),
      };
    }),
  });
}
