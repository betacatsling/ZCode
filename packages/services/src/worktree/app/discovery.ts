import { dirname, resolve } from "node:path";
import {
  worktreeCandidateSchema,
  type FilesystemEvidence,
  type WorktreeCandidate,
  type WorktreeDiscoveryResult,
} from "../contract.js";
import type { WorktreeServiceDependencies } from "./dependencies.js";
import { resolveTargetId } from "./dependencies.js";
import { isUnknownZSwitch, parsePorcelainZ, type ParsedWorktree } from "../domain/porcelain.js";

function trailingLineBreak(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1).replace(/\r$/, "") : value;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined
    : undefined;
}

function isMissingFilesystemError(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

function isGitNotFound(result: { stderr: string; exitCode: number }): boolean {
  return (
    result.exitCode !== 0 && /not a git repository|no such file or directory/i.test(result.stderr)
  );
}

export function createWorktreeDiscoverer(dependencies: WorktreeServiceDependencies) {
  return async function discover(inputPath: string): Promise<WorktreeDiscoveryResult> {
    if (!inputPath) throw new Error("worktree-path-required");
    const id = resolveTargetId(dependencies);
    try {
      await dependencies.filesystem.identity(inputPath);
    } catch (error) {
      if (isMissingFilesystemError(error)) {
        return { kind: "nonGit", targetId: id, inputPath, reason: "missing-path" };
      }
      throw error;
    }

    const bareResult = await dependencies.git.run([
      "-C",
      inputPath,
      "rev-parse",
      "--is-bare-repository",
    ]);
    if (bareResult.exitCode !== 0) {
      if (isGitNotFound(bareResult)) {
        return { kind: "nonGit", targetId: id, inputPath, reason: "not-git" };
      }
      throw new Error(
        `git discovery failed: ${bareResult.stderr || `exit ${bareResult.exitCode}`}`,
      );
    }
    const isBare = trailingLineBreak(bareResult.stdout).trim() === "true";
    const commonResult = await dependencies.git.run([
      "-C",
      inputPath,
      "rev-parse",
      "--git-common-dir",
    ]);
    if (commonResult.exitCode !== 0) {
      throw new Error(
        `git common-dir discovery failed: ${commonResult.stderr || `exit ${commonResult.exitCode}`}`,
      );
    }
    const commonDir = await dependencies.filesystem.realpath(
      resolve(inputPath, trailingLineBreak(commonResult.stdout)),
    );
    const commonDirEvidence = await dependencies.filesystem.identity(commonDir);
    const worktreeResult = await dependencies.git.run([
      "-C",
      inputPath,
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    let records: ParsedWorktree[];
    if (worktreeResult.exitCode === 0) {
      records = parsePorcelainZ(worktreeResult.stdout);
    } else if (isUnknownZSwitch(worktreeResult.stderr)) {
      throw new Error(
        "git worktree list --porcelain -z is required; upgrade the target Git version",
      );
    } else {
      throw new Error(
        `git worktree discovery failed: ${worktreeResult.stderr || `exit ${worktreeResult.exitCode}`}`,
      );
    }

    const mainRoot = commonDir.endsWith("/.git") ? dirname(commonDir) : undefined;
    const candidates: WorktreeCandidate[] = [];
    for (const [index, record] of records.entries()) {
      let canonicalPath: string;
      let filesystemEvidence: FilesystemEvidence;
      try {
        canonicalPath = await dependencies.filesystem.realpath(record.path);
        filesystemEvidence = await dependencies.filesystem.identity(canonicalPath);
      } catch (error) {
        if (isMissingFilesystemError(error)) continue;
        throw error;
      }
      candidates.push(
        worktreeCandidateSchema.parse({
          targetId: id,
          repositoryCommonDir: commonDir,
          commonDirEvidence,
          worktreePath: canonicalPath,
          filesystemEvidence,
          isMainWorktree: !isBare && (mainRoot ? canonicalPath === mainRoot : index === 0),
          head: record.head,
          locked: record.locked,
        }),
      );
    }
    if (candidates.length === 0 && !isBare)
      throw new Error("git worktree discovery contained no existing worktrees");
    return isBare
      ? {
          kind: "bare",
          targetId: id,
          inputPath,
          repositoryCommonDir: commonDir,
          commonDirEvidence,
          candidates,
        }
      : {
          kind: "git",
          targetId: id,
          inputPath,
          repositoryCommonDir: commonDir,
          commonDirEvidence,
          candidates,
        };
  };
}
