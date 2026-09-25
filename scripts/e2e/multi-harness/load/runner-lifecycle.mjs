import { git, inside, CLEANUP_DEADLINE_MS } from "./runner-fixture.mjs";
import { dirname, resolve } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";

export function cleanupRegistry(driver) {
  const callbacks = [],
    children = [];
  let disposed = false;
  return {
    registerCleanup(fn) {
      if (disposed || typeof fn !== "function") throw new Error("invalid cleanup registration");
      callbacks.push(fn);
    },
    registerChild(child) {
      if (
        disposed ||
        !child ||
        typeof child.kill !== "function" ||
        typeof child.once !== "function" ||
        !Number.isSafeInteger(child.pid) ||
        child.pid <= 0
      )
        throw new Error("invalid owned child");
      const closed = new Promise((resolve) => child.once("close", resolve));
      children.push({ child, closed });
    },
    async dispose() {
      if (disposed) return { registeredChildrenExited: children.length, failed: true };
      disposed = true;
      let failed = false,
        exitedCount = 0;
      const deadline = performance.now() + CLEANUP_DEADLINE_MS;
      // 中文：不可信的清理回调有失败截止期；超时只记录失败，不能充当子进程退出证明。
      const bounded = async (fn) => {
        let timer;
        try {
          const operation = Promise.resolve()
            .then(fn)
            .then(
              () => true,
              () => false,
            );
          const remaining = Math.max(0, deadline - performance.now());
          if (!remaining) {
            failed = true;
            return;
          }
          const done = await Promise.race([
            operation,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), remaining);
            }),
          ]);
          if (!done) failed = true;
        } finally {
          clearTimeout(timer);
        }
      };
      for (const fn of callbacks.reverse()) await bounded(fn);
      await bounded(() => driver.dispose());
      for (const { child, closed } of children) {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        } catch {
          failed = true;
        }
        let timer;
        let exited = await Promise.race([
          closed.then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 5000);
          }),
        ]);
        clearTimeout(timer);
        if (!exited) {
          failed = true;
          try {
            child.kill("SIGKILL");
          } catch {
            failed = true;
          }
          exited = await Promise.race([
            closed.then(() => true),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 5000);
            }),
          ]);
          clearTimeout(timer);
        }
        if (exited && (child.exitCode !== null || child.signalCode !== null)) exitedCount++;
        else failed = true;
      }
      return { registeredChildrenExited: exitedCount, failed };
    },
  };
}

async function existingAncestor(path) {
  let cursor = path;
  while (true) {
    try {
      return await realpath(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("cannot resolve artifact ancestor");
    cursor = parent;
  }
}
async function rejectGitArtifactLocation(path) {
  const enclosingGit = await git(path, "rev-parse", "--show-toplevel").then(
    () => true,
    () => false,
  );
  const enclosingBare = await git(path, "rev-parse", "--is-inside-git-dir").then(
    (value) => value.trim() === "true",
    () => false,
  );
  if (enclosingGit || enclosingBare)
    throw new Error("artifact base must be outside all Git checkouts");
}

export async function prepareArtifactBase(base) {
  const cwd = await realpath(process.cwd());
  if (inside(cwd, base) || inside(base, cwd))
    throw new Error("artifact base must be outside the project checkout");
  const ancestor = await existingAncestor(base);
  if (inside(cwd, ancestor)) throw new Error("artifact base must be outside the project checkout");
  await rejectGitArtifactLocation(ancestor);
  await mkdir(base, { recursive: true });
  const baseReal = await realpath(base);
  if (inside(baseReal, cwd) || inside(cwd, baseReal))
    throw new Error("artifact base must be outside the project checkout");
  await rejectGitArtifactLocation(baseReal);
  return baseReal;
}

export function isolatedEnvironment(current, paths) {
  const allowed = Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TZ"]
      .filter((key) => current[key] !== undefined)
      .map((key) => [key, current[key]]),
  );
  return {
    ...allowed,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    ZCODE_DATA_BASE_DIR: paths.desktopUserData,
    TMPDIR: paths.temporary ?? paths.home,
  };
}
export function applyIsolation(paths) {
  const next = isolatedEnvironment(process.env, paths);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, next);
}
