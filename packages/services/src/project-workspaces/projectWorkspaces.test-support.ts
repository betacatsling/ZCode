import { ProjectWorkspaceError } from "./errors.js";
import type { GitExecResult, ProjectWorkspaceFilesystemPort, ProjectWorkspaceGitPort } from "./ports.js";

export interface PorcelainFixture {
  path: string;
  oid: string;
  branch?: string;
  detached?: boolean;
  locked?: boolean;
  bare?: boolean;
}

export function encodePorcelain(records: readonly PorcelainFixture[]): string {
  return (
    records
      .map((record) => {
        const tokens = [`worktree ${record.path}`, `HEAD ${record.oid}`];
        if (record.bare) tokens.push("bare");
        else if (record.detached) tokens.push("detached");
        else if (record.branch) tokens.push(`branch refs/heads/${record.branch}`);
        if (record.locked) tokens.push("locked");
        return tokens.join("\0");
      })
      .join("\0\0") + "\0"
  );
}

export interface FsEntry {
  device: number;
  inode: number;
  real?: string;
  denied?: boolean;
}

export function createWorkspaceWorld(initial: Record<string, FsEntry>) {
  const entries = { ...initial };
  const records: PorcelainFixture[] = [];
  const calls: string[][] = [];
  const stopped: string[][] = [];
  let commonDir = "/repo/.git";
  let bare = false;
  let notGit = false;
  let missingCommon = false;
  let failList: "timeout" | "unknown-z" | null = null;
  let failRemove = false;
  let activity: "idle" | "busy" | "approval" | "unknown" = "idle";
  let releaseRemove: (() => void) | undefined;
  let removeStarted: (() => void) | undefined;
  const removeGate = {
    wait: null as Promise<void> | null,
    started: null as Promise<void> | null,
  };

  const git: ProjectWorkspaceGitPort = {
    async run(args: readonly string[]): Promise<GitExecResult> {
      const copy = [...args];
      calls.push(copy);
      if (notGit && args.includes("--is-bare-repository")) {
        return { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" };
      }
      if (args.includes("--is-bare-repository")) {
        return { exitCode: 0, stdout: bare ? "true\n" : "false\n", stderr: "" };
      }
      if (args.includes("--git-common-dir")) {
        return missingCommon
          ? { exitCode: 1, stdout: "", stderr: "permission denied" }
          : { exitCode: 0, stdout: `${commonDir}\n`, stderr: "" };
      }
      if (args.includes("list") && args.includes("-z")) {
        if (failList === "unknown-z") {
          return { exitCode: 129, stdout: "", stderr: "error: unknown option `z'" };
        }
        if (failList === "timeout") return { exitCode: 1, stdout: "", stderr: "timed out" };
        return { exitCode: 0, stdout: encodePorcelain(records), stderr: "" };
      }
      if (args.includes("status")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("submodule")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args.includes("show-ref")) return { exitCode: 1, stdout: "", stderr: "" };
      if (args.includes("--verify")) return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      if (args.includes("add")) {
        const branchIndex = args.indexOf("-b");
        const branch = branchIndex >= 0 ? args[branchIndex + 1] : args.at(-1);
        const worktreePath = branchIndex >= 0 ? args[branchIndex + 2] : args.at(-2);
        if (!branch || !worktreePath) return { exitCode: 1, stdout: "", stderr: "bad add" };
        records.push({ path: worktreePath, oid: "abc123", branch });
        entries[worktreePath] = { device: 3, inode: 30 + records.length };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("worktree") && args.includes("remove")) {
        removeStarted?.();
        if (removeGate.wait) await removeGate.wait;
        if (failRemove) return { exitCode: 1, stdout: "", stderr: "remove failed" };
        const target = args.at(-1);
        if (target) {
          const index = records.findIndex((record) => record.path === target);
          if (index >= 0) records.splice(index, 1);
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected ${copy.join(" ")}` };
    },
  };

  const filesystem: ProjectWorkspaceFilesystemPort = {
    async realpath(path: string) {
      const entry = entries[path];
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entry.real ?? path;
    },
    async identity(path: string) {
      const resolved = await this.realpath(path);
      const entry = entries[resolved] ?? entries[path];
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { device: entry.device, inode: entry.inode };
    },
    async exists(path: string) {
      return Boolean(entries[path]);
    },
    async access(path: string) {
      const entry = entries[path];
      if (!entry) return "missing";
      if (entry.denied) return "denied";
      return "ok";
    },
  };

  let nextId = 0;
  return {
    entries,
    records,
    calls,
    stopped,
    git,
    filesystem,
    idFactory: () => {
      nextId += 1;
      return `id-${nextId}`;
    },
    activityPort: {
      async inspect() {
        return activity;
      },
      async stopSessions(sessionIds: readonly string[]) {
        stopped.push([...sessionIds]);
      },
    },
    setCommonDir(value: string) {
      commonDir = value;
    },
    setBare(value: boolean) {
      bare = value;
    },
    setNotGit(value: boolean) {
      notGit = value;
    },
    setFailList(value: "timeout" | "unknown-z" | null) {
      failList = value;
    },
    setFailRemove(value: boolean) {
      failRemove = value;
    },
    setActivity(value: "idle" | "busy" | "approval" | "unknown") {
      activity = value;
    },
    holdRemove() {
      let release: () => void = () => undefined;
      let started: () => void = () => undefined;
      removeGate.wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      removeGate.started = new Promise<void>((resolve) => {
        started = resolve;
      });
      removeStarted = started;
      releaseRemove = release;
      return removeGate.started ?? Promise.resolve();
    },
    releaseRemove() {
      releaseRemove?.();
    },
    mutatingCalls() {
      return calls.filter((args) =>
        args.some((arg) => ["add", "remove", "init", "prune", "checkout", "branch"].includes(arg)),
      );
    },
  };
}

export function assertCode(error: unknown, code: string): boolean {
  return error instanceof ProjectWorkspaceError && error.code === code;
}
