import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DataRootLock } from "./lock.js";
import { acquireUninstallLock } from "./uninstallGuard.js";
import { resolveServerLayout } from "./paths.js";

test("dead Supervisor PID cannot reclaim lock while its orphan Core may remain alive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-orphan-lock-"));
  const path = join(dir, "server.lock");
  const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = exited.pid!;
  await new Promise<void>((resolve) => exited.once("close", () => resolve()));
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    const record = JSON.stringify({ pid: deadPid, ownerToken: "prior-supervisor" });
    await writeFile(path, record);
    const lock = new DataRootLock(path);
    assert.deepEqual(await lock.inspect(), { state: "stale", pid: deadPid });
    await assert.rejects(lock.acquire(), /orphan|manual|reclaim|already running/i);
    assert.equal(await readFile(path, "utf8"), record);
    assert.equal(orphan.exitCode, null);
  } finally {
    const closed = new Promise<void>((resolve) => orphan.once("close", () => resolve()));
    orphan.kill("SIGKILL");
    await closed;
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale lock blocks offline uninstall, but owned fresh lock releases cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-lock-uninstall-"));
  const layout = resolveServerLayout(dir);
  try {
    const lock = new DataRootLock(layout.lockFile);
    await lock.acquire();
    assert.deepEqual(await lock.inspect(), { state: "active", pid: process.pid });
    await lock.release();
    assert.deepEqual(await lock.inspect(), { state: "missing" });
    await writeFile(layout.lockFile, JSON.stringify({ pid: 2147483647, ownerToken: "stale" }));
    await assert.rejects(acquireUninstallLock(layout), /stale/);
    assert.equal((await lock.inspect()).state, "stale");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
