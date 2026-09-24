import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
import path from "node:path";
import {
  discoverGitWorktrees,
  type GitWorktreeDiscovery,
  type GitWorktreeFact,
} from "./adapters/gitWorktreeBackend.js";

export interface FileIdentity {
  device: number;
  inode: number;
}
export interface RepositoryInspection {
  discovery: GitWorktreeDiscovery;
  commonIdentity: FileIdentity;
  candidates: readonly (GitWorktreeFact & {
    adminIdentity: FileIdentity | null;
    adminPath: string | null;
  })[];
}

export function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.device === b.device && a.inode === b.inode;
}

async function identity(file: string): Promise<FileIdentity> {
  const info = await stat(await realpath(file));
  return { device: info.dev, inode: info.ino };
}

export async function inspectRepository(pathOnTarget: string): Promise<RepositoryInspection> {
  const discovery = await discoverGitWorktrees(pathOnTarget);
  const candidates = await Promise.all(
    discovery.worktrees.map(async (fact) => {
      try {
        const actual = await discoverGitWorktrees(fact.path);
        if (actual.gitCommonDir !== discovery.gitCommonDir || actual.worktreeRoot !== fact.path)
          return { ...fact, adminIdentity: null, adminPath: null };
        const { stdout } = await exec(
          "git",
          ["-C", fact.path, "rev-parse", "--path-format=absolute", "--absolute-git-dir"],
          { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
        );
        const adminPath = await realpath(stdout.trimEnd());
        return { ...fact, adminIdentity: await identity(adminPath), adminPath };
      } catch {
        return { ...fact, adminIdentity: null, adminPath: null };
      }
    }),
  );
  return { discovery, commonIdentity: await identity(discovery.gitCommonDir), candidates };
}

export function assertSameRepository(
  inspected: RepositoryInspection,
  expected: FileIdentity,
): void {
  if (!sameFile(inspected.commonIdentity, expected))
    throw new Error("Repository instance changed on this target");
}

export function findCandidate(
  inspected: RepositoryInspection,
  requestedPath: string,
): (typeof inspected.candidates)[number] | undefined {
  return inspected.candidates.find(
    (entry) => path.resolve(entry.path) === path.resolve(requestedPath),
  );
}
