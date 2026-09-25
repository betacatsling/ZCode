import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getAppConfigDirFor, recoverStaleProfileOwnerLock } from "@zcode/services/node";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { Supervisor } from "./supervisor.js";
import {
  coreAuthorityProfilePath,
  evaluateCoreAuthorityLock,
  readCoreOwnerRecord,
  writeCoreOwnerRecord,
} from "./coreOwnerRecovery.js";

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  for (let i = 0; i < timeoutMs / 20; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

/** spawn 一个真实可死的子进程并等待它被完全回收（ESRCH 才是合法的死亡证明）。 */
async function spawnThenReap(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0);
  child.kill("SIGKILL");
  await once(child, "exit");
  return pid;
}

async function spawnSleeper(): Promise<{ pid: number; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  assert.ok(typeof pid === "number" && pid > 0);
  return {
    pid,
    kill: async () => {
      child.kill("SIGKILL");
      await once(child, "exit");
    },
  };
}

async function writeLock(profilePath: string, pid: number): Promise<void> {
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(
    `${profilePath}.lock`,
    JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", pid }),
    { flag: "wx", mode: 0o600 },
  );
}

test("recoverStaleProfileOwnerLock: proven dead owner recovered; all other shapes refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-owner-recovery-"));
  try {
    const profilePath = join(dir, "core-authority.json");

    // 锁不存在：absent
    assert.deepEqual(await recoverStaleProfileOwnerLock(profilePath, { expectedOwnerPid: 1 }), {
      outcome: "absent",
    });

    // 畸形内容：拒绝且不动文件
    await mkdir(dir, { recursive: true });
    await writeFile(`${profilePath}.lock`, "not-json", { flag: "wx" });
    assert.deepEqual(await recoverStaleProfileOwnerLock(profilePath, { expectedOwnerPid: 1 }), {
      outcome: "refused",
      reason: "malformed-owner",
    });
    assert.equal(await readFile(`${profilePath}.lock`, "utf8"), "not-json");

    // 异主：lock pid 与证据不符 → 拒绝
    const foreignDead = await spawnThenReap();
    const recordedDead = await spawnThenReap();
    assert.notEqual(foreignDead, recordedDead);
    await rm(`${profilePath}.lock`);
    await writeLock(profilePath, foreignDead);
    assert.deepEqual(
      await recoverStaleProfileOwnerLock(profilePath, { expectedOwnerPid: recordedDead }),
      { outcome: "refused", reason: "owner-identity-mismatch" },
    );

    // PID 复用语义：lock pid 属于一个真实存活进程 → owner-alive 拒绝
    const live = await spawnSleeper();
    await rm(`${profilePath}.lock`);
    await writeLock(profilePath, live.pid);
    assert.deepEqual(
      await recoverStaleProfileOwnerLock(profilePath, { expectedOwnerPid: live.pid }),
      { outcome: "refused", reason: "owner-alive" },
    );
    await live.kill();
    // 同一 pid 在被真实回收后才允许恢复
    assert.deepEqual(
      await recoverStaleProfileOwnerLock(profilePath, { expectedOwnerPid: live.pid }),
      { outcome: "recovered" },
    );
    // 恢复后锁已不存在
    await assert.rejects(readFile(`${profilePath}.lock`, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evaluateCoreAuthorityLock: missing record refuses any present lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-owner-eval-"));
  try {
    const layout = resolveServerLayout(join(dir, "server"));
    await mkdir(layout.runDir, { recursive: true });
    // 无记录 + 无锁 → clear
    assert.equal((await evaluateCoreAuthorityLock(layout)).kind, "clear");
    // 无记录 + 有锁 → refused（无可信归属证明）
    const dead = await spawnThenReap();
    await writeLock(coreAuthorityProfilePath(layout), dead);
    const refused = await evaluateCoreAuthorityLock(layout);
    assert.equal(refused.kind, "refused");
    // 写入记录匹配后 → recovered
    await writeCoreOwnerRecord(layout, { pid: dead, generation: 7 });
    const recovered = await evaluateCoreAuthorityLock(layout);
    assert.deepEqual(recovered, { kind: "recovered", pid: dead });
    assert.equal(
      await readFile(`${coreAuthorityProfilePath(layout)}.lock`, "utf8").catch(() => "gone"),
      "gone",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Supervisor crash relaunch recovers only the proven reaped Core owner lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-supervisor-recovery-"));
  const layout = resolveServerLayout(join(dir, "server"));
  await ensureServerInstallOwnership(layout);
  const provider = join(dir, "builtin.json");
  await writeFile(provider, "{}\n");
  const fixture = fileURLToPath(
    new URL("../server-core/coreOwnerLockChild.fixture.ts", import.meta.url),
  );
  const supervisor = new Supervisor({
    layout,
    version: "fixture",
    launcher: {
      launch: (generation) =>
        fork(fixture, [String(generation)], {
          execArgv: ["--import", import.meta.resolve("tsx")],
          env: {
            ...process.env,
            ZCODE_SERVER_ROOT: layout.serverRoot,
            ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        }),
    },
  });
  try {
    await supervisor.start();
    await until(() => supervisor.status().state === "ready");
    const first = supervisor.status();
    const firstPid = first.pid;
    assert.ok(firstPid);

    // 真实 stale-owner 场景：SIGKILL 让 Core 来不及释放 profile lock；
    // Supervisor 观察到 exit/close（退出+回收的正面证明）后重拉下一代。
    process.kill(firstPid, "SIGKILL");
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().pid !== firstPid,
      20_000,
    );
    const second = supervisor.status();
    assert.equal(second.generation, 2);

    // 新 owner 的锁内容必须是新 pid；旧的 owner 记录已被覆盖
    const lockRaw = JSON.parse(
      await readFile(`${coreAuthorityProfilePath(layout)}.lock`, "utf8"),
    ) as { pid: number; token: string };
    assert.equal(lockRaw.pid, second.pid);
    const record = await readCoreOwnerRecord(layout);
    assert.deepEqual(record, { pid: second.pid, generation: 2 });
    assert.ok(
      getAppConfigDirFor(layout.dataBaseDir).length > 0,
      "profile path derivation stays consistent",
    );
  } finally {
    await supervisor.stop("test-end").catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("Supervisor refuses to launch against a foreign Core authority owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-supervisor-foreign-"));
  const layout = resolveServerLayout(join(dir, "server"));
  await ensureServerInstallOwnership(layout);
  const provider = join(dir, "builtin.json");
  await writeFile(provider, "{}\n");
  // 锁里是一个 Supervisor 从未启动过的死进程 pid → 无记录 + 异主
  const foreignDead = await spawnThenReap();
  await mkdir(dirname(coreAuthorityProfilePath(layout)), { recursive: true });
  await writeLock(coreAuthorityProfilePath(layout), foreignDead);
  const fixture = fileURLToPath(
    new URL("../server-core/coreOwnerLockChild.fixture.ts", import.meta.url),
  );
  const supervisor = new Supervisor({
    layout,
    version: "fixture",
    launcher: {
      launch: (generation) =>
        fork(fixture, [String(generation)], {
          execArgv: ["--import", import.meta.resolve("tsx")],
          env: {
            ...process.env,
            ZCODE_SERVER_ROOT: layout.serverRoot,
            ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        }),
    },
  });
  try {
    await assert.rejects(supervisor.start(), /recovery refused|no trusted launch record/);
    // 拒绝后 lock 原样保留，未发生任何 spawn/删除副作用
    const lockRaw = JSON.parse(
      await readFile(`${coreAuthorityProfilePath(layout)}.lock`, "utf8"),
    ) as { pid: number };
    assert.equal(lockRaw.pid, foreignDead);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
