import type { SessionHierarchyFile } from "@zcode/shared/agent-host";
import type { WorktreeCatalogFile } from "@zcode/services/worktree";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ProjectSidebarNativeSessionMetadata } from "./contract.js";

export function workspaceKey(workspace: {
  workspaceIdentity?: string | null;
  worktreePath: string;
}): string {
  return workspace.workspaceIdentity?.trim() || workspace.worktreePath;
}

export async function readNativeSessionMetadata(params: {
  taskService: {
    listTasks(request: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): Promise<ZCodeTaskMeta[]>;
  };
  worktrees: WorktreeCatalogFile;
  migration: SessionHierarchyFile | null;
  targetId: string;
}): Promise<ReadonlyMap<string, ProjectSidebarNativeSessionMetadata>> {
  if (!params.taskService?.listTasks) return new Map();
  const bindings = new Map(params.worktrees.bindings.map((binding) => [binding.id, binding]));
  const workspaces = params.worktrees.workspaces.filter((workspace) => {
    const binding = bindings.get(workspace.repositoryBindingId);
    return (
      workspace.lifecycle === "active" &&
      workspace.verification === "verified" &&
      binding?.executionTargetId === params.targetId
    );
  });
  const settled = await Promise.allSettled(
    workspaces.map((workspace) =>
      params.taskService.listTasks({
        workspacePath: workspace.worktreePath,
        ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
      }),
    ),
  );
  const tasks = new Map<string, ZCodeTaskMeta>();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const task of result.value) tasks.set(task.taskId, task);
  }
  const metadata = new Map<string, ProjectSidebarNativeSessionMetadata>();
  for (const record of params.migration?.records ?? []) {
    if (record.ownerKind !== "native-v4") continue;
    const task = tasks.get(record.nativeSessionId);
    if (!task || !task.title.trim()) continue;
    if (
      (task.workspaceIdentity?.trim() || task.workspacePath) !==
      (record.workspaceIdentity?.trim() || record.workspacePath)
    )
      continue;
    metadata.set(record.hierarchySessionId, { title: task.title, updatedAt: task.updatedAt });
  }
  return metadata;
}
