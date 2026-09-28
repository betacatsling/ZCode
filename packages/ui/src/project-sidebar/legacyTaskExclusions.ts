import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

export function projectSidebarLegacyTaskExclusionKey(task: {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string | null;
}): string {
  return JSON.stringify([
    buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity ?? undefined),
    task.taskId,
  ]);
}
