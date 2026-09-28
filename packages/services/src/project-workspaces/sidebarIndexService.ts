import type { AgentSessionRecord, Project, RepositoryBinding, WorktreeWorkspace } from "./planTypes.js";

export interface SessionActivityInput {
  sessionId: string;
  activity?: "idle" | "starting" | "running" | "waiting" | "cancelling";
  connection?: "live" | "stale" | "offline" | "unknown";
  lastTurn?: "succeeded" | "failed" | "unknown";
  unread?: boolean;
  pendingApproval?: boolean;
  problem?: boolean;
  unconfirmedError?: boolean;
  internalChild?: boolean;
  archived?: boolean;
  topLevel?: boolean;
}

export type SidebarHint = "attention" | "error" | "running" | "unread" | "idle";
export type ConnectionFreshness = "live" | "stale" | "offline" | "unknown";

export interface SidebarIndexInput {
  projects: readonly Project[];
  bindings: readonly RepositoryBinding[];
  workspaces: readonly WorktreeWorkspace[];
  sessions: readonly AgentSessionRecord[];
  hiddenWorkspaceIds: readonly string[];
  archivedSessionIds: readonly string[];
  removedProjectIds: readonly string[];
  freshnessByTargetId: Readonly<Record<string, ConnectionFreshness>>;
  activities?: readonly SessionActivityInput[];
  /** null 表示扫描失败，未知数量不能显示成 0。 */
  discoveredNotAdopted: number | null;
  query?: string;
  collapsedWorkspaceIds?: readonly string[];
}

export interface SidebarWorkspaceRow {
  id: string;
  projectId: string;
  title: string;
  hidden: boolean;
  collapsed: boolean;
  agentTotal: number;
  agentMatched: number;
  primary: SidebarHint;
  counts: Record<SidebarHint, number>;
  targetFreshness: ConnectionFreshness;
  sessionConnection: ConnectionFreshness;
}

export interface SidebarProjectRow {
  id: string;
  name: string;
  attention: boolean;
  attentionWorkspaceIds: string[];
  workspaces: SidebarWorkspaceRow[];
}

export interface SidebarIndex {
  projects: SidebarProjectRow[];
  discoveredNotAdopted: number | null;
  hiddenAdopted: number;
  selectedSessionId?: never;
}

const HINT_ORDER: readonly SidebarHint[] = ["attention", "error", "running", "unread", "idle"];
const CONNECTION_RANK: Record<ConnectionFreshness, number> = {
  offline: 3,
  stale: 2,
  unknown: 1,
  live: 0,
};

function hintFor(activity: SessionActivityInput | undefined): SidebarHint {
  if (activity?.pendingApproval || activity?.problem || activity?.activity === "waiting") return "attention";
  if (activity?.unconfirmedError || activity?.lastTurn === "failed") return "error";
  if (
    activity?.activity === "starting" ||
    activity?.activity === "running" ||
    activity?.activity === "cancelling"
  ) {
    return "running";
  }
  if (activity?.unread && activity.lastTurn === "succeeded") return "unread";
  return "idle";
}

function worseConnection(current: ConnectionFreshness, next: ConnectionFreshness): ConnectionFreshness {
  return CONNECTION_RANK[next] > CONNECTION_RANK[current] ? next : current;
}

function countedSession(
  session: AgentSessionRecord,
  archived: ReadonlySet<string>,
  activity: SessionActivityInput | undefined,
): boolean {
  if (archived.has(session.id) || activity?.archived || activity?.internalChild) return false;
  if (activity?.topLevel === false) return false;
  return true;
}

/** 侧栏摘要只看会话行和活动计数，不读取历史正文。 */
export function buildSidebarIndex(input: SidebarIndexInput): SidebarIndex {
  const hidden = new Set(input.hiddenWorkspaceIds);
  const archived = new Set(input.archivedSessionIds);
  const removed = new Set(input.removedProjectIds);
  const collapsed = new Set(input.collapsedWorkspaceIds ?? []);
  const activityById = new Map((input.activities ?? []).map((activity) => [activity.sessionId, activity]));
  const query = input.query?.trim().toLowerCase();
  const projects = input.projects
    .filter((project) => !removed.has(project.id))
    .map((project) => {
      const workspaces = input.workspaces
        .filter((workspace) => workspace.projectId === project.id)
        .map((workspace) => {
          const binding = input.bindings.find((item) => item.id === workspace.repositoryBindingId);
          const sessions = input.sessions.filter((session) => session.workspaceId === workspace.id);
          const visible = sessions.filter((session) => countedSession(session, archived, activityById.get(session.id)));
          const matched = query
            ? visible.filter((session) => session.title.toLowerCase().includes(query))
            : visible;
          const counts: Record<SidebarHint, number> = {
            attention: 0,
            error: 0,
            running: 0,
            unread: 0,
            idle: 0,
          };
          let sessionConnection: ConnectionFreshness = "live";
          let sawConnection = false;
          for (const session of visible) {
            const activity = activityById.get(session.id);
            counts[hintFor(activity)] += 1;
            if (activity?.connection) {
              sessionConnection = worseConnection(sawConnection ? sessionConnection : "live", activity.connection);
              sawConnection = true;
            }
          }
          if (!sawConnection) sessionConnection = "unknown";
          const primary = HINT_ORDER.find((hint) => counts[hint] > 0) ?? "idle";
          return {
            id: workspace.id,
            projectId: project.id,
            title: workspace.title,
            hidden: hidden.has(workspace.id),
            collapsed: collapsed.has(workspace.id),
            agentTotal: visible.length,
            agentMatched: matched.length,
            primary: visible.length === 0 ? "idle" : primary,
            counts,
            targetFreshness: binding
              ? (input.freshnessByTargetId[binding.executionTargetId] ?? "unknown")
              : "unknown",
            sessionConnection,
          } satisfies SidebarWorkspaceRow;
        });
      const attentionWorkspaceIds = workspaces
        .filter((workspace) => workspace.counts.attention > 0)
        .map((workspace) => workspace.id);
      return {
        id: project.id,
        name: project.name,
        attention: attentionWorkspaceIds.length > 0,
        attentionWorkspaceIds,
        workspaces,
      } satisfies SidebarProjectRow;
    });
  return {
    projects,
    discoveredNotAdopted: input.discoveredNotAdopted,
    hiddenAdopted: input.workspaces.filter((workspace) => hidden.has(workspace.id)).length,
  };
}
