import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile, mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { recoverStaleOwnerMarkers, recoverStaleProfileOwnerLock } from "@zcode/services/node";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { Supervisor } from "./supervisor.js";
import {
  coreConfigDir,
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

/** markerPath 是 marker 文件本身（x.lock 或 x.owner），内容为 {token,pid}。 */
async function writeMarker(markerPath: string, pid: number): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(
    markerPath,
    JSON.stringify({ token: "00000000-0000-4000-8000-000000000000", pid }),
    { flag: "wx", mode: 0o600 },
  );
}

const authorityMarker = (layout: ReturnType<typeof resolveServerLayout>): string =>
  join(coreConfigDir(layout), "core-authority.json.lock");
const catalogMarker = (layout: ReturnType<typeof resolveServerLayout>): string =>
  join(coreConfigDir(layout), "workspace-hierarchy", "profile", "catalog.json.lock");
const targetMarker = (layout: ReturnType<typeof resolveServerLayout>): string =>
  join(coreConfigDir(layout), "workspace-hierarchy", "target", "a".repeat(64) + ".owner");
const migrationMarker = (layout: ReturnType<typeof resolveServerLayout>): string =>
  join(coreConfigDir(layout), "native-migration", "mapping.json.lock");

test("recoverStaleProfileOwnerLock: proven dead owner recovered; all other shapes refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-owner-recovery-"));
  try {
    const markerPath = join(dir, "core-authority.json.lock");

    // marker 不存在：absent
    assert.deepEqual(await recoverStaleProfileOwnerLock(markerPath, { expectedOwnerPid: 1 }), {
      outcome: "absent",
    });

    // 畸形内容：拒绝且不动文件
    await writeFile(markerPath, "not-json", { flag: "wx" });
    assert.deepEqual(await recoverStaleProfileOwnerLock(markerPath, { expectedOwnerPid: 1 }), {
      outcome: "refused",
      reason: "malformed-owner",
    });
    assert.equal(await readFile(markerPath, "utf8"), "not-json");

    // 异主：marker pid 与证据不符 → 拒绝
    const foreignDead = await spawnThenReap();
    const recordedDead = await spawnThenReap();
    assert.notEqual(foreignDead, recordedDead);
    await rm(markerPath);
    await writeMarker(markerPath, foreignDead);
    assert.deepEqual(
      await recoverStaleProfileOwnerLock(markerPath, { expectedOwnerPid: recordedDead }),
      { outcome: "refused", reason: "owner-identity-mismatch" },
    );

    // PID 复用语义：marker pid 属于一个真实存活进程 → owner-alive 拒绝
    const live = await spawnSleeper();
    await rm(markerPath);
    await writeMarker(markerPath, live.pid);
    assert.deepEqual(
      await recoverStaleProfileOwnerLock(markerPath, { expectedOwnerPid: live.pid }),
      { outcome: "refused", reason: "owner-alive" },
    );
    await live.kill();
    // 同一 pid 在被真实回收后才允许恢复
    assert.deepEqual(
      await recoverStaleProfileOwnerLock(markerPath, { expectedOwnerPid: live.pid }),
      { outcome: "recovered" },
    );
    // 恢复后锁已不存在
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recoverStaleOwnerMarkers: all-or-nothing preflight across the managed namespace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-owner-markers-"));
  try {
    const markers = [
      join(dir, "core-authority.json.lock"),
      join(dir, "profile", "catalog.json.lock"),
      join(dir, "target", `${"b".repeat(64)}.owner`),
      join(dir, "native-migration", "mapping.json.lock"),
    ];
    const dead = await spawnThenReap();
    for (const marker of markers) await writeMarker(marker, dead);
    const clear = await recoverStaleOwnerMarkers(markers, { expectedOwnerPid: dead });
    assert.deepEqual(clear, { outcome: "clear", recoveredMarkers: markers.length });
    for (const marker of markers) await assert.rejects(readFile(marker, "utf8"), /ENOENT/);

    // 任一异主 marker → 整批拒绝且全部原样保留
    const ours = await spawnThenReap();
    const foreign = await spawnThenReap();
    for (const marker of markers) await writeMarker(marker, ours);
    const foreignMarker = markers[2]!;
    await rm(foreignMarker);
    await writeMarker(foreignMarker, foreign);
    const refused = await recoverStaleOwnerMarkers(markers, { expectedOwnerPid: ours });
    assert.equal(refused.outcome, "refused");
    if (refused.outcome === "refused") assert.equal(refused.marker, foreignMarker);
    for (const marker of markers)
      assert.ok(await readFile(marker, "utf8"), `${marker} must remain`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("evaluateCoreAuthorityLock: missing record refuses any present marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "core-owner-eval-"));
  try {
    const layout = resolveServerLayout(join(dir, "server"));
    await mkdir(layout.runDir, { recursive: true });
    // 无记录 + 无 marker → clear
    assert.equal((await evaluateCoreAuthorityLock(layout)).kind, "clear");
    // 无记录 + 有 marker → refused（无可信归属证明）
    const dead = await spawnThenReap();
    await writeMarker(authorityMarker(layout), dead);
    const refused = await evaluateCoreAuthorityLock(layout);
    assert.equal(refused.kind, "refused");
    // 写入记录匹配后 → recovered，且整个命名空间被清理
    await writeCoreOwnerRecord(layout, { pid: dead, generation: 7 });
    await writeMarker(catalogMarker(layout), dead);
    await writeMarker(targetMarker(layout), dead);
    await writeMarker(migrationMarker(layout), dead);
    const recovered = await evaluateCoreAuthorityLock(layout);
    assert.deepEqual(recovered, { kind: "recovered", pid: dead });
    for (const marker of [
      authorityMarker(layout),
      catalogMarker(layout),
      targetMarker(layout),
      migrationMarker(layout),
    ]) {
      await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
    }
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

    // 再埋一个 catalog/target/migration 残留 marker，模拟 Core 曾惰性打开过它们。
    await writeMarker(catalogMarker(layout), firstPid);
    await writeMarker(targetMarker(layout), firstPid);
    await writeMarker(migrationMarker(layout), firstPid);

    // 埋一条真实的 durable command journal 记录（accepted 但 outcome unknown）：
    // 恢复边界只允许动 owner marker，journal 字节必须原样保留且不被重放。
    const journalPath = join(
      coreConfigDir(layout),
      "workspace-hierarchy",
      "agent-host",
      "aa11.command.jsonl",
    );
    await mkdir(dirname(journalPath), { recursive: true });
    const journalHandle = await open(journalPath, "wx");
    try {
      await journalHandle.writeFile(
        `${JSON.stringify({ commandId: "cmd-unknown-1", status: "execution-unknown", acceptedAt: 1 })}\n`,
      );
      await journalHandle.sync();
    } finally {
      await journalHandle.close();
    }
    const journalBefore = await readFile(journalPath, "utf8");

    // 真实 stale-owner 场景：SIGKILL 让 Core 来不及释放 owner marker；
    // Supervisor 观察到 exit/close（退出+回收的正面证明）后重拉下一代。
    process.kill(firstPid, "SIGKILL");
    await until(
      () => supervisor.status().state === "ready" && supervisor.status().pid !== firstPid,
      20_000,
    );
    const second = supervisor.status();
    assert.equal(second.generation, 2);

    // 恢复不得触碰 journal/命令状态：accepted-but-unknown 永远不被重放。
    assert.equal(await readFile(journalPath, "utf8"), journalBefore);

    // 新 owner 的锁内容必须是新 pid；旧的 owner 记录已被覆盖
    const lockRaw = JSON.parse(await readFile(authorityMarker(layout), "utf8")) as {
      pid: number;
      token: string;
    };
    assert.equal(lockRaw.pid, second.pid);
    const record = await readCoreOwnerRecord(layout);
    assert.deepEqual(record, { pid: second.pid, generation: 2 });
    // 惰性命名空间的残留 marker 也随同一旧 owner 一起被清
    for (const marker of [catalogMarker(layout), targetMarker(layout), migrationMarker(layout)])
      await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
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
  // marker 里是一个 Supervisor 从未启动过的死进程 pid → 无记录 + 异主
  const foreignDead = await spawnThenReap();
  await writeMarker(authorityMarker(layout), foreignDead);
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
    // 拒绝后 marker 原样保留，未发生任何 spawn/删除副作用
    const lockRaw = JSON.parse(await readFile(authorityMarker(layout), "utf8")) as {
      pid: number;
    };
    assert.equal(lockRaw.pid, foreignDead);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
