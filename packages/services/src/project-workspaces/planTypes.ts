/**
 * 计划第 13.2 节的领域草案，按该节字段逐字抄录，不追加字段、不改身份语义。
 * 合并契约 PR 后改为从 shared 公开入口导入。
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
  // Git 自身解析后的信息；路径用于定位，不独自充当永久 ID。
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
  // modelBinding、backendRef、状态和时间沿用前述会话模型。
}
