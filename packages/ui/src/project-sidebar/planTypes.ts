/**
 * 计划草案的本地抄写，不是已合并的运行时契约。
 * 合并契约后改为 `@zcode/shared` 公开入口，并删除本文件。
 * Project、RepositoryBinding、WorktreeWorkspace、AgentSessionRecord 的字段
 * 与计划第 13.2 节一致，不在这些实体上追加字段。
 * SidebarSnapshot 只组装上述实体，以及第 13.1 / 13.5 节已经点名的侧栏展示事实。
 */

export interface Project {
  id: string;
  name: string;
  iconAssetId?: string;
  defaultWorkspaceId?: string;
}

export interface RepositoryBinding {
  id: string;
  projectId: string;
  executionTargetId: string;
  gitCommonDir: string;
}

export interface WorktreeWorkspace {
  id: string;
  projectId: string;
  repositoryBindingId: string;
  title: string;
  worktreePath: string;
  worktreeGeneration: string;
  isMainWorktree: boolean;
  head:
    | { kind: "branch"; ref: string; oid: string | null }
    | { kind: "detached"; oid: string };
  origin: "created" | "adopted";
  lifecycle: "active" | "archived" | "missing" | "removed";
}

export interface AgentSessionRecord {
  id: string;
  workspaceId: string;
  harnessId: string;
  title: string;
  // modelBinding、backendRef、状态和时间沿用前述会话模型，不在此实体上加字段。
}

/** 第 13.5 节列出的执行活动。 */
export type SessionActivity = "idle" | "starting" | "running" | "waiting" | "cancelling";

/** 连接新鲜度与轮次结果分开保存。 */
export type ConnectionFreshness = "live" | "stale" | "offline" | "unknown";

/** succeeded 只表示最近一轮结束，不表示会话被销毁。 */
export type RecentTurnOutcome = "none" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface SidebarSessionNode {
  session: AgentSessionRecord;
  activity: SessionActivity;
  freshness: ConnectionFreshness;
  recentOutcome: RecentTurnOutcome;
  unread: boolean;
  pendingInteractionCount: number;
  updatedAt: number;
  /** 只用于 tooltip / 次要文案，不参与 Harness 图标选择。 */
  modelLabel?: string;
}

export interface SidebarWorkspaceNode {
  workspace: WorktreeWorkspace;
  /** 展示名，例如 Local Mac / server1。身份仍是 RepositoryBinding.executionTargetId。 */
  targetLabel: string;
  sessions: readonly SidebarSessionNode[];
}

export interface SidebarProjectNode {
  project: Project;
  repositoryBinding: RepositoryBinding;
  workspaces: readonly SidebarWorkspaceNode[];
  /** 已发现但未接管的工作区数量，不是已接管后隐藏的工作区。 */
  hiddenDiscoveredCount: number;
}

export interface SidebarSnapshot {
  projects: readonly SidebarProjectNode[];
}
