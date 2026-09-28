import { ProjectWorkspaceError } from "./errors.js";

export interface WorkspaceIdentityInput {
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
  worktreePath?: string | null;
  executionTargetId?: string | null;
}

/**
 * 身份键与仓库约定一致：远程优先用裁剪后的 workspaceIdentity，空白时才回退路径。
 * 路径本身不裁剪，避免把合法尾随空白误当成另一个工作区。
 */
export function workspaceIdentityKey(input: WorkspaceIdentityInput): string {
  const identity = input.workspaceIdentity?.trim();
  const path = input.workspacePath ?? input.worktreePath ?? "";
  return identity || path;
}

/** 目标不同或身份键不同都不算同一个工作区，不能只拿绝对路径对齐。 */
export function sameWorkspaceIdentity(
  left: WorkspaceIdentityInput,
  right: WorkspaceIdentityInput,
): boolean {
  if (!left.executionTargetId || !right.executionTargetId) return false;
  if (left.executionTargetId !== right.executionTargetId) return false;
  const leftKey = workspaceIdentityKey(left);
  const rightKey = workspaceIdentityKey(right);
  return leftKey.length > 0 && leftKey === rightKey;
}

const UNSAFE_REF = /[ ~^:?*[\\'"`$;&|<>()]|\.\.|^[-.]|@{|\/$|^\//;

export function assertSafeGitRef(ref: string): void {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 256 ||
    hasControlChar(ref) ||
    UNSAFE_REF.test(ref)
  ) {
    throw new ProjectWorkspaceError("unsafe-ref");
  }
}

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function assertRelativeCwd(cwd: string): void {
  if (cwd === ".") return;
  if (
    cwd.length === 0 ||
    cwd.length > 4096 ||
    cwd.includes("\0") ||
    cwd.includes("\\") ||
    cwd.startsWith("/") ||
    /^[A-Za-z]:/.test(cwd)
  ) {
    throw new ProjectWorkspaceError("unsafe-cwd");
  }
  if (cwd.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new ProjectWorkspaceError("unsafe-cwd");
  }
}
