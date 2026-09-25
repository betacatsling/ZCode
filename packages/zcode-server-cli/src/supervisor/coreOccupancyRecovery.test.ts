import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getAppConfigDir } from "@zcode/services/node";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import {
  OccupancyRecoveryRefused,
  recoverManagedOccupancyLocks,
  type ManagedOccupancyRecord,
} from "../runtime/occupancyRecovery.js";
import { resolveServerLayout, type ServerLayout } from "../runtime/paths.js";
import { Supervisor } from "./supervisor.js";

const FIXTURE = fileURLToPath(new URL("./coreOccupancyChild.fixture.ts", import.meta.url));

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 750; i++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function requestFixtureReply(
  child: ChildProcess,
  command: Record<string, unknown>,
  replyType: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error(`fixture reply ${replyType} timed out`));
    }, 5_000);
    const onMessage = (raw: unknown): void => {
      if (raw && typeof raw === "object" && (raw as { type?: string }).type === replyType) {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(raw as Record<string, unknown>);
      }
    };
    child.on("message", onMessage);
    child.send(command);
  });
}

interface SupervisorHandle {
  supervisor: Supervisor;
  launched: ChildProcess[];
}

function createOccupancySupervisor(options: {
  layout: ServerLayout;
  providerConfig: string;
  journalRoot: string;
}): SupervisorHandle {
  const launched: ChildProcess[] = [];
  const supervisor = new Supervisor({
    layout: options.layout,
    version: "fixture",
    launcher: {
      launch: (generation) => {
        // 与生产 launcher 同一约定：ZCODE_DATA_BASE_DIR 恒为 layout.dataBaseDir，
        // 保证 Supervisor 的恢复扫描与子进程 getAppConfigDir() 指向同一命名空间。
        const child = fork(FIXTURE, [String(generation)], {
          execArgv: ["--import", import.meta.resolve("tsx")],
          env: {
            ...process.env,
            ZCODE_SERVER_ROOT: options.layout.serverRoot,
            ZCODE_DATA_BASE_DIR: options.layout.dataBaseDir,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: options.providerConfig,
            ZCODE_FIXTURE_JOURNAL_ROOT: options.journalRoot,
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        launched.push(child);
        return child;
      },
    },
  });
  return { supervisor, launched };
}

async function killAll(children: ChildProcess[]): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

// ---------- 模块级逐锁判定矩阵（真实文件，合成 supervisor 记录） ----------

test("occupancy recovery: absent, malformed, legacy, foreign, live and ambiguous locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "occupancy-unit-"));
  try {
    const configRoot = join(dir, ".zcode", "v2");
    const lockPath = join(configRoot, "core-authority.json.lock");
    await mkdir(join(configRoot, "workspace-hierarchy", "target"), { recursive: true });
    const installationId = randomUUID();
    const epoch = randomUUID();
    const owners = new Map<string, ManagedOccupancyRecord>([
      [epoch, { pid: 424242, generation: 1, ownerEpoch: epoch, installationId, reaped: true }],
    ]);
    const recover = () =>
      recoverManagedOccupancyLocks({ configRoot, installationId, owners });

    // 没有残留锁：空恢复。
    assert.deepEqual(await recover(), []);

    // 损坏内容 fail closed，文件原样保留。
    await writeFile(lockPath, "not-json");
    await assert.rejects(recover(), OccupancyRecoveryRefused);
    assert.equal(await readFile(lockPath, "utf8"), "not-json");

    // 旧格式 {token,pid}（无 ownerEpoch）→ 人工路径。
    const legacy = JSON.stringify({ token: "t", pid: 424242 });
    await writeFile(lockPath, legacy);
    await assert.rejects(recover(), /malformed or legacy/);
    assert.equal(await readFile(lockPath, "utf8"), legacy);

    // 外来 epoch（任何 Supervisor 都未申报）→ 拒绝；pid 是否存活完全无关，
    // 这里直接用当前测试进程的真实存活 pid 证明“live owner”不会被删除。
    const foreign = JSON.stringify({
      token: "x",
      pid: process.pid,
      ownerEpoch: randomUUID(),
    });
    await writeFile(lockPath, foreign);
    await assert.rejects(recover(), /not an attested managed generation/);
    assert.equal(await readFile(lockPath, "utf8"), foreign);

    // 申报过 epoch 但 installationId 不匹配（另一安装）→ 拒绝。
    const otherInstallOwners = new Map<string, ManagedOccupancyRecord>([
      [
        epoch,
        { pid: 424242, generation: 1, ownerEpoch: epoch, installationId: randomUUID(), reaped: true },
      ],
    ]);
    const good = JSON.stringify({ token: "t", pid: 424242, ownerEpoch: epoch });
    await writeFile(lockPath, good);
    await assert.rejects(
      recoverManagedOccupancyLocks({
        configRoot,
        installationId,
        owners: otherInstallOwners,
      }),
      /not an attested managed generation/,
    );

    // epoch 命中但 pid 与申报不一致（PID 复用/篡改痕迹）→ 拒绝。
    await writeFile(lockPath, JSON.stringify({ token: "t", pid: 777, ownerEpoch: epoch }));
    await assert.rejects(recover(), /pid does not match/);

    // epoch+pid 命中但 child 未被观察到收割 → 拒绝（存活 owner 绝不被退休）。
    const liveOwners = new Map<string, ManagedOccupancyRecord>([
      [epoch, { pid: 424242, generation: 1, ownerEpoch: epoch, installationId, reaped: false }],
    ]);
    await writeFile(lockPath, good);
    await assert.rejects(
      recoverManagedOccupancyLocks({ configRoot, installationId, owners: liveOwners }),
      /not been observed terminated/,
    );
    assert.equal(await readFile(lockPath, "utf8"), good);

    // 完整证明链 → 退休；第二次调用读到干净状态，幂等。
    assert.deepEqual(await recover(), [lockPath]);
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
    assert.deepEqual(await recover(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("occupancy recovery scans target leases and refuses the whole set all-or-nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "occupancy-atomic-"));
  try {
    const configRoot = join(dir, ".zcode", "v2");
    const targetDir = join(configRoot, "workspace-hierarchy", "target");
    await mkdir(targetDir, { recursive: true });
    const installationId = randomUUID();
    const epoch = randomUUID();
    const owners = new Map<string, ManagedOccupancyRecord>([
      [epoch, { pid: 424242, generation: 1, ownerEpoch: epoch, installationId, reaped: true }],
    ]);
    // 可证明死亡的 target lease + 外来的 profile lock：任何一把拒绝则全部不动作。
    const leasePath = join(targetDir, `${"a".repeat(64)}.owner`);
    await writeFile(leasePath, JSON.stringify({ token: "t", pid: 424242, ownerEpoch: epoch }));
    const lockPath = join(configRoot, "core-authority.json.lock");
    const foreign = JSON.stringify({ token: "x", pid: 1, ownerEpoch: randomUUID() });
    await writeFile(lockPath, foreign);
    await assert.rejects(
      recoverManagedOccupancyLocks({ configRoot, installationId, owners }),
      /not an attested managed generation/,
    );
    // all-or-nothing：catalog/target 已证明可退休的文件也不允许被先删。
    assert.equal(await readFile(leasePath, "utf8"), JSON.stringify({ token: "t", pid: 424242, ownerEpoch: epoch }));
    assert.equal(await readFile(lockPath, "utf8"), foreign);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent recovery calls are race-safe: no error and no unsafe delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "occupancy-race-"));
  try {
    const configRoot = join(dir, ".zcode", "v2");
    const lockPath = join(configRoot, "core-authority.json.lock");
    const unrelated = join(configRoot, "unrelated.txt");
    await mkdir(configRoot, { recursive: true });
    const installationId = randomUUID();
    const epoch = randomUUID();
    const owners = new Map<string, ManagedOccupancyRecord>([
      [epoch, { pid: 424242, generation: 1, ownerEpoch: epoch, installationId, reaped: true }],
    ]);
    await writeFile(lockPath, JSON.stringify({ token: "t", pid: 424242, ownerEpoch: epoch }));
    await writeFile(unrelated, "keep");
    const [first, second] = await Promise.all([
      recoverManagedOccupancyLocks({ configRoot, installationId, owners }),
      recoverManagedOccupancyLocks({ configRoot, installationId, owners }),
    ]);
    // POSIX 上并发 unlink 不保证第二方 ENOENT，FS 层无法区分“谁先删”；可验证的
    // 不变量是：双方都只可能申报已证明死亡的锁、文件被删除一次、无关文件不受波及。
    // 真正的“只有一个 claimant”由 server.lock + Supervisor 单飞扫描保证（见下方竞态用例）。
    assert.deepEqual(new Set([...first, ...second]), new Set([lockPath]));
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/);
    assert.equal(await readFile(unrelated, "utf8"), "keep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- 真实进程集成：fork fixture → SIGKILL → supervisor 证明链 → 恢复 ----------

test("managed Core SIGKILL: supervisor retires proven locks; accepted command stays execution-unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-occupancy-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const providerConfig = join(dir, "builtin.json");
  const journalRoot = join(dir, "host-journal");
  const { supervisor, launched } = createOccupancySupervisor({
    layout,
    providerConfig,
    journalRoot,
  });
  try {
    await ensureServerInstallOwnership(layout);
    await writeFile(providerConfig, "{}\n");
    await supervisor.start();
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().generation === 1,
      "generation-1 ready",
    );
    const gen1 = launched[0]!;
    const configRoot = getAppConfigDir(layout.dataBaseDir);
    const profileLockPath = join(configRoot, "core-authority.json.lock");
    const catalogLockPath = join(
      configRoot,
      "workspace-hierarchy",
      "profile",
      "catalog.json.lock",
    );
    const gen1ProfileLock = JSON.parse(await readFile(profileLockPath, "utf8")) as {
      pid: number;
      ownerEpoch: string;
    };
    assert.equal(gen1ProfileLock.pid, gen1.pid);
    assert.ok(typeof gen1ProfileLock.ownerEpoch === "string");

    // 一条真实持久化的 send 命令停在 accepted（durable admission，不证明完成）。
    const commandId = `cmd-${randomUUID()}`;
    const accepted = await requestFixtureReply(
      gen1,
      { command: "fixture-journal-accept", commandId },
      "fixture-journal-accepted",
    );
    assert.equal(accepted.commandId, commandId);

    gen1.kill("SIGKILL");
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().generation === 2,
      "generation-2 ready after occupancy recovery",
    );
    const gen2 = launched[1]!;
    // 三类 marker 全部以新 owner 重新取得——旧锁若未逐锁退休，fixture 会 EEXIST 崩溃。
    const gen2ProfileLock = JSON.parse(await readFile(profileLockPath, "utf8")) as {
      pid: number;
      ownerEpoch: string;
    };
    const gen2CatalogLock = JSON.parse(await readFile(catalogLockPath, "utf8")) as {
      pid: number;
      ownerEpoch: string;
    };
    assert.equal(gen2ProfileLock.pid, gen2.pid);
    assert.equal(gen2CatalogLock.pid, gen2.pid);
    assert.notEqual(gen2ProfileLock.ownerEpoch, gen1ProfileLock.ownerEpoch);

    // 服务可用 ≠ 允许重放：崩溃前 accepted 的命令必须仍是 execution-unknown。
    const status = (await requestFixtureReply(
      gen2,
      { command: "fixture-journal-status", commandId },
      "fixture-journal-status",
    )) as { status: string };
    assert.equal(status.status, "execution-unknown");

    // HTTP 面确认服务可用（真实 listen）。
    const port = supervisor.status().port;
    assert.ok(port);
    const response = await fetch(`http://127.0.0.1:${port}/api/server-info`);
    assert.equal(response.status, 200);
    await response.body?.cancel();

    // 恢复可重复：gen2 再被 SIGKILL，gen3 仍能被证明并恢复。
    gen2.kill("SIGKILL");
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().generation === 3,
      "generation-3 ready after repeated occupancy recovery",
    );
  } finally {
    await supervisor.stop("test-cleanup").catch(() => undefined);
    await killAll(launched);
    await rm(dir, { recursive: true, force: true });
  }
});

test("foreign stale profile lock fails supervisor start closed and is never mutated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-occupancy-foreign-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const providerConfig = join(dir, "builtin.json");
  const journalRoot = join(dir, "host-journal");
  const { supervisor, launched } = createOccupancySupervisor({
    layout,
    providerConfig,
    journalRoot,
  });
  try {
    await ensureServerInstallOwnership(layout);
    await writeFile(providerConfig, "{}\n");
    const configRoot = getAppConfigDir(layout.dataBaseDir);
    const lockPath = join(configRoot, "core-authority.json.lock");
    await mkdir(configRoot, { recursive: true });
    const foreign = JSON.stringify({
      token: "foreign",
      pid: 999_999_999,
      ownerEpoch: randomUUID(),
    });
    await writeFile(lockPath, foreign, { flag: "wx" });
    await assert.rejects(supervisor.start(), /not recoverable|manual/i);
    assert.equal(launched.length, 0);
    assert.equal(await readFile(lockPath, "utf8"), foreign);
    assert.equal(supervisor.status().state, "stopped");
  } finally {
    await supervisor.stop("test-cleanup").catch(() => undefined);
    await killAll(launched);
    await rm(dir, { recursive: true, force: true });
  }
});

test("tampered lock (dead child pid under forged epoch) refuses crash restart and keeps evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-occupancy-tamper-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const providerConfig = join(dir, "builtin.json");
  const journalRoot = join(dir, "host-journal");
  const { supervisor, launched } = createOccupancySupervisor({
    layout,
    providerConfig,
    journalRoot,
  });
  try {
    await ensureServerInstallOwnership(layout);
    await writeFile(providerConfig, "{}\n");
    await supervisor.start();
    await until(() => supervisor.status().state === "ready", "generation-1 ready");
    const gen1 = launched[0]!;
    const configRoot = getAppConfigDir(layout.dataBaseDir);
    const lockPath = join(configRoot, "core-authority.json.lock");
    const original = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      ownerEpoch: string;
    };
    // 篡改现场：真实 pid 保留、epoch 伪造（模拟 PID 复用下的外来记录）。
    const forged = JSON.stringify({
      token: "forged",
      pid: original.pid,
      ownerEpoch: randomUUID(),
    });
    await writeFile(lockPath, forged);
    gen1.kill("SIGKILL");
    await until(
      () => supervisor.status().state === "stop-failed",
      "recovery refusal stop-failed",
    );
    // 绝不拉起注定 EEXIST 的替代 Core；篡改文件原样保留。
    assert.equal(launched.length, 1);
    assert.equal(await readFile(lockPath, "utf8"), forged);
    assert.match(supervisor.status().lastExitReason ?? "", /occupancy|unverifiable/i);
  } finally {
    await supervisor.stop("test-cleanup").catch(() => undefined);
    await killAll(launched);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new supervisor instance cannot recover the previous supervisor's dead child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-occupancy-prev-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const providerConfig = join(dir, "builtin.json");
  const journalRoot = join(dir, "host-journal");
  const first = createOccupancySupervisor({ layout, providerConfig, journalRoot });
  const second = createOccupancySupervisor({ layout, providerConfig, journalRoot });
  try {
    await ensureServerInstallOwnership(layout);
    await writeFile(providerConfig, "{}\n");
    await first.supervisor.start();
    await until(() => first.supervisor.status().state === "ready", "gen1 ready");
    const gen1 = first.launched[0]!;
    const configRoot = getAppConfigDir(layout.dataBaseDir);
    const lockPath = join(configRoot, "core-authority.json.lock");
    const staleContent = await readFile(lockPath, "utf8");
    gen1.kill("SIGKILL");
    await until(
      () => first.supervisor.status().state === "crashed",
      "gen1 observed crashed",
    );
    // 在 1s 崩溃重启定时器前停止旧 Supervisor：它带走了收割证据，磁盘上只剩
    // 它 child 的残留锁——新 Supervisor 没有任何 IPC 申报记录，必须 fail closed。
    await first.supervisor.stop("swap-supervisor");
    assert.equal(first.launched.length, 1);
    assert.equal(await readFile(lockPath, "utf8"), staleContent);
    await assert.rejects(second.supervisor.start(), /not recoverable|manual/i);
    assert.equal(second.launched.length, 0);
    assert.equal(await readFile(lockPath, "utf8"), staleContent);
  } finally {
    await first.supervisor.stop("test-cleanup").catch(() => undefined);
    await second.supervisor.stop("test-cleanup").catch(() => undefined);
    await killAll(first.launched);
    await killAll(second.launched);
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent supervisors racing the same data root: exactly one claimant proceeds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-occupancy-race-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const providerConfig = join(dir, "builtin.json");
  const journalRoot = join(dir, "host-journal");
  const first = createOccupancySupervisor({ layout, providerConfig, journalRoot });
  const second = createOccupancySupervisor({ layout, providerConfig, journalRoot });
  try {
    await ensureServerInstallOwnership(layout);
    await writeFile(providerConfig, "{}\n");
    // server.lock(wx) 串行化两个候选 Supervisor；恢复扫描只在锁内发生，因此两个
    // 并发 start 里恰好只有一个能进入 occupancy 评估并拉起 Core。
    const results = await Promise.allSettled([
      first.supervisor.start(),
      second.supervisor.start(),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(String((rejected[0] as PromiseRejectedResult).reason), /manual recovery required/i);
    const winner = fulfilled[0] === results[0] ? first : second;
    await until(() => winner.supervisor.status().state === "ready", "winner ready");
  } finally {
    await first.supervisor.stop("test-cleanup").catch(() => undefined);
    await second.supervisor.stop("test-cleanup").catch(() => undefined);
    await killAll(first.launched);
    await killAll(second.launched);
    await rm(dir, { recursive: true, force: true });
  }
});

test("live attested owner is never retired while its child is still running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-occupancy-live-"));
  const layout = resolveServerLayout(join(dir, "server"));
  const providerConfig = join(dir, "builtin.json");
  const journalRoot = join(dir, "host-journal");
  const { supervisor, launched } = createOccupancySupervisor({
    layout,
    providerConfig,
    journalRoot,
  });
  try {
    await ensureServerInstallOwnership(layout);
    await writeFile(providerConfig, "{}\n");
    await supervisor.start();
    await until(() => supervisor.status().state === "ready", "generation-1 ready");
    const configRoot = getAppConfigDir(layout.dataBaseDir);
    const lockPath = join(configRoot, "core-authority.json.lock");
    const before = await readFile(lockPath, "utf8");
    // 即使 owner 是本 Supervisor 已申报的 child，未观察到 exit/close 也绝不退休——
    // 否则等价于对存活 writer 偷锁。
    const internal = supervisor as unknown as {
      recoverManagedCoreOccupancy(): Promise<void>;
    };
    await assert.rejects(
      internal.recoverManagedCoreOccupancy(),
      /not been observed terminated/,
    );
    assert.equal(await readFile(lockPath, "utf8"), before);
    assert.equal(supervisor.status().state, "ready");
  } finally {
    await supervisor.stop("test-cleanup").catch(() => undefined);
    await killAll(launched);
    await rm(dir, { recursive: true, force: true });
  }
});
