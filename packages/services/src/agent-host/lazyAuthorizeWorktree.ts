import { isAbsolute } from "node:path";
import type { SessionSpec } from "@zcode/shared/agent-host";
import type { IWorktreeService } from "../projectWorkspaceServices.js";

/**
 * Lazy Host worktree admission: absolute path + catalog lookup + revalidate
 * generation recheck. Catalog presence alone must not admit a stale generation.
 */
export async function authorizeLazyWorktreeAdmission(input: {
  readonly worktrees: IWorktreeService | undefined;
  readonly targetId: string;
  readonly spec: SessionSpec;
  readonly realPath: string;
}): Promise<boolean> {
  if (
    !input.worktrees ||
    !isAbsolute(input.spec.execution.worktreePath) ||
    input.realPath !== input.spec.execution.worktreePath
  ) {
    return false;
  }
  const catalog = await input.worktrees.read();
  const workspace = catalog.workspaces.find(
    (candidate) => candidate.id === input.spec.execution.workspaceId,
  );
  if (!workspace) return false;
  const revalidated = await input.worktrees.revalidate(workspace.id);
  if (
    revalidated.status !== "verified" ||
    revalidated.workspace.id !== workspace.id ||
    revalidated.workspace.worktreePath !== input.realPath ||
    revalidated.workspace.worktreeGeneration !== input.spec.execution.worktreeGeneration
  ) {
    return false;
  }
  const key = workspace.workspaceIdentity?.trim() || workspace.worktreePath;
  return (
    input.spec.execution.targetId === input.targetId &&
    input.spec.execution.workspaceId === workspace.id &&
    input.spec.execution.worktreeGeneration === workspace.worktreeGeneration &&
    input.spec.execution.workspaceIdentity === key &&
    input.spec.execution.worktreePath === workspace.worktreePath &&
    workspace.lifecycle === "active" &&
    workspace.verification === "verified"
  );
}
