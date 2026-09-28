import type { ProjectWorkspaceDeps } from "./ports.js";
import { createRemovalCommands } from "./removal.js";
import { createSessionCommands } from "./sessions.js";
import { createWorkspaceCommands, describeSharedWorkspace } from "./workspaceCommands.js";

/** 执行位置绑在已接管的 worktree 工作区上；同工作区多个会话不另建 worktree。 */
export function createWorktreeService(deps: ProjectWorkspaceDeps) {
  return {
    ...createWorkspaceCommands(deps),
    ...createRemovalCommands(deps),
    ...createSessionCommands(deps),
    describeSharedWorkspace,
  };
}

export { describeSharedWorkspace };
