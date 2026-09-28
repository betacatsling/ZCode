/**
 * 实体类型来自 `@zcode/shared` 的 agent-host 公开入口。
 * 侧栏节点只组装这些实体，以及计划第 13.1 / 13.5 节已经点名的展示事实。
 */
import type {
  AgentSessionRecord,
  Project,
  RepositoryBinding,
  WorktreeWorkspace,
} from "@zcode/shared/agent-host";

export type { AgentSessionRecord, Project, RepositoryBinding, WorktreeWorkspace };

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
