import { spawn } from "node:child_process";
import { cpus, platform, arch, totalmem, hostname } from "node:os";
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const HOUR8 = 8 * 60 * 60 * 1000;
export const SCHEMA_VERSION = 2;
export const runtime = {
  nodeVersion: process.version,
  v8Version: process.versions.v8,
  platform: platform(),
  arch: arch(),
};
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const CLEANUP_DEADLINE_MS = 750;
const defaults = {
  delivery: "desktop-continuous",
  mode: "acceptance",
  durationMs: HOUR8,
  eventCount: 100_000,
  worktreeCount: 50,
  sessionCount: 10,
  expandedCount: 5,
  sampleEveryMs: 60_000,
  reconnectEveryMs: 300_000,
  idleMs: 60_000,
  maxBacklog: 10_000,
  maxOwnedChildren: 32,
};
export const inside = (root, child) => {
  const r = relative(root, child);
  return r === "" || (r !== ".." && !r.startsWith("../") && !isAbsolute(r));
};
export const machine = createHash("sha256")
  .update(
    JSON.stringify({
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      cpus: cpus().map((c) => c.model),
      totalmem: totalmem(),
    }),
  )
  .digest("hex")
  .slice(0, 16);

export function validateOptions(input = {}) {
  const options = { ...defaults, ...input };
  if (!["smoke", "benchmark", "acceptance"].includes(options.mode)) throw new Error("invalid mode");
  if (!["desktop-continuous", "web-remote-replayable"].includes(options.delivery))
    throw new Error("invalid delivery");
  for (const key of [
    "durationMs",
    "eventCount",
    "worktreeCount",
    "sessionCount",
    "expandedCount",
    "sampleEveryMs",
    "reconnectEveryMs",
    "idleMs",
    "maxBacklog",
    "maxOwnedChildren",
  ]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === "idleMs" ? 0 : 1))
      throw new Error(`invalid ${key}`);
  }
  if (options.expandedCount > options.worktreeCount || options.sessionCount < options.expandedCount)
    throw new Error("invalid workspace/session distribution");
  if (
    options.mode === "benchmark" &&
    (typeof options.benchmarkDatasetId !== "string" ||
      !/^[a-zA-Z0-9._-]{1,128}$/.test(options.benchmarkDatasetId))
  )
    throw new Error("invalid benchmarkDatasetId");
  if (options.mode === "acceptance") {
    if (options.durationMs < HOUR8) throw new Error("acceptance requires 8 hours elapsed");
    if (options.eventCount < 100_000) throw new Error("acceptance requires 100000 events");
    if (options.worktreeCount < 50) throw new Error("acceptance requires 50 worktrees");
    if (options.idleMs < 60_000)
      throw new Error("acceptance requires 60 seconds post-cleanup idle");
    if (options.sessionCount < 10 || options.expandedCount < 5)
      throw new Error("acceptance requires 10 sessions across 5 expanded workspaces");
  }
  return options;
}

export async function git(cwd, ...args) {
  const child = spawn("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    err += chunk;
  });
  const code = await new Promise((res, rej) => {
    child.on("error", rej);
    child.on("close", res);
  });
  if (code !== 0)
    throw new Error(`disposable Git ${args[0]} failed (exit ${code}): ${err.slice(0, 300)}`);
  return out;
}

export async function createFixture(artifactDir, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("invalid worktree count");
  const repo = join(artifactDir, "tiny-git-repo");
  await mkdir(repo, { recursive: false });
  await git(repo, "init", "-q");
  await writeFile(join(repo, "tiny.txt"), "tiny fixture\n");
  await git(repo, "add", "--", "tiny.txt");
  await git(
    repo,
    "-c",
    "user.name=Load Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "tiny disposable fixture",
  );
  const worktrees = [repo];
  for (let i = 1; i < count; i++) {
    const path = join(artifactDir, `linked-${String(i).padStart(3, "0")}`);
    await git(repo, "worktree", "add", "--detach", "-q", path, "HEAD");
    worktrees.push(path);
  }
  // Read Git's actual registry, not an invented list of branches or folders.
  const registered = await git(repo, "worktree", "list", "--porcelain", "-z");
  const paths = registered
    .split("\0")
    .filter((x) => x.startsWith("worktree "))
    .map((x) => x.slice(9));
  const canonical = await Promise.all(worktrees.map((w) => realpath(w)));
  if (paths.length !== count || canonical.some((w) => !paths.includes(w)))
    throw new Error("Git worktree registry mismatch");
  return { repo, worktrees };
}

export function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}
export async function isolation(root) {
  const paths = {
    home: join(root, "home"),
    xdgConfig: join(root, "xdg-config"),
    xdgData: join(root, "xdg-data"),
    desktopUserData: join(root, "desktop-user-data"),
    webProfile: join(root, "web-profile"),
    temporary: join(root, "temporary"),
  };
  for (const path of Object.values(paths)) {
    await mkdir(path);
    if (!inside(root, await realpath(path)))
      throw new Error("isolation path escaped artifact root");
  }
  return paths;
}
export function metadataCheck(meta, paths, mode) {
  if (
    !meta ||
    typeof meta.productionCommit !== "string" ||
    (!/^[a-f0-9]{40}$/.test(meta.productionCommit) &&
      !(mode === "smoke" && meta.productionCommit === "test-only")) ||
    !/^[a-zA-Z0-9._-]{1,64}$/.test(meta.driverVersion ?? "") ||
    !meta.paths
  )
    throw new Error("missing driver provenance/isolation attestation");
  for (const [key, value] of Object.entries(paths))
    if (meta.paths[key] !== value) throw new Error(`unverified effective ${key}`);
}
export function configOf(o) {
  return {
    delivery: o.delivery,
    benchmarkDatasetId: o.mode === "benchmark" ? o.benchmarkDatasetId : null,
    durationMs: o.durationMs,
    eventCount: o.eventCount,
    worktreeCount: o.worktreeCount,
    sessionCount: o.sessionCount,
    expandedCount: o.expandedCount,
    sampleEveryMs: o.sampleEveryMs,
    reconnectEveryMs: o.reconnectEveryMs,
    maxBacklog: o.maxBacklog,
    maxOwnedChildren: o.maxOwnedChildren,
    idleMs: o.idleMs,
  };
}
