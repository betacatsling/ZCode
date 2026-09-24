import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], mutate = false): Promise<string> {
  const { stdout } = await exec(
    "git",
    [...(mutate ? ["-c", "core.hooksPath=/dev/null"] : []), "-C", cwd, ...args],
    {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: mutate ? "1" : "0" },
    },
  );
  return (stdout as Buffer).toString("utf8");
}

function line(output: string): string {
  return output.replace(/\n$/, "");
}

export interface GitWorktreeFact {
  path: string;
  kind: "main" | "linked" | "bare";
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: string | null;
  prunable: string | null;
}
export interface GitWorktreeDiscovery {
  gitCommonDir: string;
  worktreeRoot: string | null;
  worktrees: GitWorktreeFact[];
}

/** Git's -z output uses NUL for fields AND blank-record boundaries; never split paths on whitespace. */
export function parseGitWorktreePorcelainZ(output: string): GitWorktreeFact[] {
  if (!output.endsWith("\0"))
    throw new Error("Invalid Git worktree porcelain: missing NUL terminator");
  const records = output.split("\0\0").filter(Boolean);
  return records.map((record, index) => {
    const fields = record.split("\0");
    if (!fields[0]?.startsWith("worktree "))
      throw new Error("Invalid Git worktree porcelain: no worktree");
    const location = fields[0].slice("worktree ".length);
    if (!path.isAbsolute(location))
      throw new Error("Invalid Git worktree porcelain: relative path");
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? null;
    const branch = fields.find((field) => field.startsWith("branch "))?.slice(7) ?? null;
    const bare = fields.includes("bare");
    if (!bare && !head) throw new Error("Invalid Git worktree porcelain: no HEAD");
    return {
      path: location,
      kind: bare ? "bare" : index === 0 ? "main" : "linked",
      head,
      branch,
      detached: fields.includes("detached"),
      locked:
        fields
          .find((field) => field === "locked" || field.startsWith("locked "))
          ?.slice(6)
          .trimStart() ?? null,
      prunable:
        fields
          .find((field) => field === "prunable" || field.startsWith("prunable "))
          ?.slice(8)
          .trimStart() ?? null,
    };
  });
}

export async function discoverGitWorktrees(cwd: string): Promise<GitWorktreeDiscovery> {
  const directory = await realpath(cwd);
  // Probe the actual command, not a version string: older Git versions cannot safely encode paths.
  const output = await git(directory, ["worktree", "list", "--porcelain", "-z"]);
  const common = line(
    await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const bare = line(await git(directory, ["rev-parse", "--is-bare-repository"])) === "true";
  const root = bare
    ? null
    : line(await git(directory, ["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  return {
    gitCommonDir: await realpath(path.resolve(directory, common)),
    worktreeRoot: root,
    worktrees: parseGitWorktreePorcelainZ(output),
  };
}

export async function resolveGitWorktreeCwd(root: string, cwd: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalCwd = await realpath(cwd);
  const relative = path.relative(canonicalRoot, canonicalCwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Cwd escapes worktree");
  const found = await discoverGitWorktrees(canonicalCwd);
  if (found.worktreeRoot !== canonicalRoot)
    throw new Error("Cwd belongs to a different Git repository");
  return canonicalCwd;
}

async function hasGitLocks(common: string, gitDir: string): Promise<boolean> {
  for (const directory of [common, gitDir]) {
    for (const name of [
      "index.lock",
      "HEAD.lock",
      "packed-refs.lock",
      "config.lock",
      "shallow.lock",
    ]) {
      try {
        await lstat(path.join(directory, name));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return false;
}

async function gitDir(cwd: string): Promise<string> {
  return line(await git(cwd, ["rev-parse", "--path-format=absolute", "--absolute-git-dir"]));
}

export interface CreateGitWorktreeOptions {
  repositoryPath: string;
  path: string;
  branch: string;
  mode: "new" | "existing";
  baseRef?: string;
}

export async function createGitWorktree(
  options: CreateGitWorktreeOptions,
): Promise<GitWorktreeFact> {
  const { repositoryPath, branch, mode } = options;
  const discovered = await discoverGitWorktrees(repositoryPath);
  if (
    !path.isAbsolute(options.path) ||
    !branch ||
    (mode !== "new" && mode !== "existing") ||
    (mode === "existing" && options.baseRef !== undefined)
  )
    throw new Error("Invalid worktree creation request");
  const destination = path.join(
    await realpath(path.dirname(options.path)),
    path.basename(options.path),
  );
  if (line(await git(repositoryPath, ["check-ref-format", "--branch", branch])) !== branch)
    throw new Error("Branch name is not literal");
  if (discovered.worktrees.some((entry) => entry.branch === `refs/heads/${branch}`))
    throw new Error("Branch is already checked out");
  if (await hasGitLocks(discovered.gitCommonDir, await gitDir(repositoryPath)))
    throw new Error("Git repository has lock files");
  try {
    await lstat(destination);
    throw new Error("Destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let exists = true;
  try {
    await git(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
    exists = false;
  }
  if ((mode === "new" && exists) || (mode === "existing" && !exists))
    throw new Error("Branch existence does not match creation mode");
  let args: string[];
  if (mode === "new") {
    if (!options.baseRef) throw new Error("New branch requires a base ref");
    const oid = line(
      await git(repositoryPath, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${options.baseRef}^{commit}`,
      ]),
    );
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error("Invalid commit ref");
    args = ["worktree", "add", "-b", branch, "--", destination, oid];
  } else {
    args = ["worktree", "add", "--", destination, branch];
  }
  await git(repositoryPath, args, true);
  const created = await discoverGitWorktrees(repositoryPath);
  const entry = created.worktrees.find((item) => item.path === destination);
  if (!entry) throw new Error("Git created a worktree but it could not be rediscovered");
  return entry;
}

export interface GitRemovePreflight {
  worktree: GitWorktreeFact;
  isMain: boolean;
  dirty: boolean;
  untracked: boolean;
  submodules: boolean;
  locked: boolean;
  prunable: boolean;
  gitLocks: boolean;
}

export async function preflightRemoveGitWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<GitRemovePreflight> {
  const discovery = await discoverGitWorktrees(repositoryPath);
  const requested = await realpath(worktreePath);
  const worktree = discovery.worktrees.find((entry) => entry.path === requested);
  if (!worktree) throw new Error("Path is not a worktree of this repository");
  const gitLocks = await hasGitLocks(discovery.gitCommonDir, await gitDir(requested));
  if (worktree.kind === "bare" || worktree.prunable !== null) {
    return {
      worktree,
      isMain: worktree.kind !== "linked",
      dirty: false,
      untracked: false,
      submodules: false,
      locked: worktree.locked !== null,
      prunable: worktree.prunable !== null,
      gitLocks,
    };
  }
  const status = await git(requested, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
    "--ignore-submodules=none",
  ]);
  const entries = status.split("\0").filter(Boolean);
  const staged = await git(requested, ["ls-files", "--stage", "-z"]);
  return {
    worktree,
    isMain: worktree.kind === "main",
    dirty: entries.some((entry) => !entry.startsWith("?? ") && !entry.startsWith("!! ")),
    untracked: entries.some((entry) => entry.startsWith("?? ") || entry.startsWith("!! ")),
    submodules: staged.split("\0").some((entry) => entry.startsWith("160000 ")),
    locked: worktree.locked !== null,
    prunable: false,
    gitLocks,
  };
}

export async function removeGitWorktree(
  repositoryPath: string,
  worktreePath: string,
): Promise<void> {
  const facts = await preflightRemoveGitWorktree(repositoryPath, worktreePath);
  if (
    facts.isMain ||
    facts.dirty ||
    facts.untracked ||
    facts.submodules ||
    facts.locked ||
    facts.prunable ||
    facts.gitLocks
  )
    throw new Error("Worktree has removal risks");
  await git(repositoryPath, ["worktree", "remove", "--", facts.worktree.path], true);
}
