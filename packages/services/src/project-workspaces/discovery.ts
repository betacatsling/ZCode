import { isAbsolute, resolve, sep } from "node:path";
import { isErrno, ProjectWorkspaceError } from "./errors.js";
import type { ProjectWorkspaceDeps } from "./ports.js";
import type { WorktreeWorkspace } from "./planTypes.js";
import { isUnknownZSwitch, parsePorcelainZ } from "./porcelain.js";
import type { FilesystemIdentity, GitExecResult } from "./ports.js";

export interface DiscoveredWorktree {
  executionTargetId: string;
  worktreePath: string;
  gitCommonDir: string;
  isMainWorktree: boolean;
  head: WorktreeWorkspace["head"];
  locked: boolean;
  evidence: FilesystemIdentity;
  commonDirEvidence: FilesystemIdentity;
}

export type DiscoveryReport =
  | {
      kind: "folder";
      executionTargetId: string;
      inputPath: string;
      reason: "not-git" | "missing-path";
      plainFolder: true;
    }
  | {
      kind: "bare";
      executionTargetId: string;
      inputPath: string;
      gitCommonDir: string;
      candidates: DiscoveredWorktree[];
      needsWorkspace: boolean;
    }
  | {
      kind: "git";
      executionTargetId: string;
      inputPath: string;
      gitCommonDir: string;
      candidates: DiscoveredWorktree[];
    }
  | {
      kind: "scan-failed";
      executionTargetId: string;
      inputPath: string;
      reason: "timeout" | "permission" | "disconnected" | "error";
    }
  | { kind: "upgrade-required"; executionTargetId: string; inputPath: string };

function failureReason(result: GitExecResult): "timeout" | "permission" | "disconnected" | "error" {
  const text = result.stderr.toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("permission")) return "permission";
  if (text.includes("disconnected") || text.includes("could not resolve")) return "disconnected";
  return "error";
}

function isNotGit(result: GitExecResult): boolean {
  return (
    result.exitCode !== 0 && /not a git repository|no such file or directory/i.test(result.stderr)
  );
}

function trimBreak(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1).replace(/\r$/, "") : value;
}

export function sameEvidence(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return (
    left.device !== null &&
    right.device !== null &&
    left.inode !== null &&
    right.inode !== null &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

/** 发现只读取版本、common dir 和 porcelain -z，不修改仓库。 */
export async function discoverRepository(
  deps: ProjectWorkspaceDeps,
  inputPath: string,
): Promise<DiscoveryReport> {
  const executionTargetId = deps.executionTargetId;
  if (!inputPath) throw new ProjectWorkspaceError("worktree-path-required");
  try {
    await deps.filesystem.identity(inputPath);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return {
        kind: "folder",
        executionTargetId,
        inputPath,
        reason: "missing-path",
        plainFolder: true,
      };
    }
    return { kind: "scan-failed", executionTargetId, inputPath, reason: "permission" };
  }

  const bare = await deps.git.run(["-C", inputPath, "rev-parse", "--is-bare-repository"]);
  if (bare.exitCode !== 0) {
    if (isNotGit(bare)) {
      return { kind: "folder", executionTargetId, inputPath, reason: "not-git", plainFolder: true };
    }
    return { kind: "scan-failed", executionTargetId, inputPath, reason: failureReason(bare) };
  }
  const isBare = trimBreak(bare.stdout).trim() === "true";
  const common = await deps.git.run(["-C", inputPath, "rev-parse", "--git-common-dir"]);
  if (common.exitCode !== 0) {
    return { kind: "scan-failed", executionTargetId, inputPath, reason: failureReason(common) };
  }
  const rawCommon = trimBreak(common.stdout);
  let gitCommonDir: string;
  let commonDirEvidence: FilesystemIdentity;
  try {
    gitCommonDir = await deps.filesystem.realpath(
      isAbsolute(rawCommon) ? rawCommon : resolve(inputPath, rawCommon),
    );
    commonDirEvidence = await deps.filesystem.identity(gitCommonDir);
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return { kind: "scan-failed", executionTargetId, inputPath, reason: "error" };
    }
    return { kind: "scan-failed", executionTargetId, inputPath, reason: "permission" };
  }

  const listed = await deps.git.run([
    "--git-dir",
    gitCommonDir,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  if (listed.exitCode !== 0) {
    if (isUnknownZSwitch(listed.stderr)) {
      return { kind: "upgrade-required", executionTargetId, inputPath };
    }
    return { kind: "scan-failed", executionTargetId, inputPath, reason: failureReason(listed) };
  }
  const records = parsePorcelainZ(listed.stdout).filter((record) => !record.bare);
  const mainRoot = gitCommonDir.endsWith(`${sep}.git`)
    ? gitCommonDir.slice(0, -`${sep}.git`.length)
    : null;
  const candidates: DiscoveredWorktree[] = [];
  for (const record of records) {
    try {
      const worktreePath = await deps.filesystem.realpath(record.path);
      const evidence = await deps.filesystem.identity(worktreePath);
      candidates.push({
        executionTargetId,
        worktreePath,
        gitCommonDir,
        isMainWorktree: !isBare && mainRoot !== null && worktreePath === mainRoot,
        head: record.head,
        locked: record.locked,
        evidence,
        commonDirEvidence,
      });
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) continue;
      return { kind: "scan-failed", executionTargetId, inputPath, reason: "permission" };
    }
  }
  if (isBare) {
    return {
      kind: "bare",
      executionTargetId,
      inputPath,
      gitCommonDir,
      candidates,
      needsWorkspace: candidates.length === 0,
    };
  }
  return { kind: "git", executionTargetId, inputPath, gitCommonDir, candidates };
}
