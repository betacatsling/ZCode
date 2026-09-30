import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStoppedServerStatus, type ServerStatus } from "../contracts.js";
import { runServerCli } from "../cli.js";
import { createHostBootstrapToken } from "../server-core/hostBootstrapAuth.js";
import {
  mergeCoreHostBootstrapToken,
  readCoreHostBootstrapFile,
  removeCoreHostBootstrapFile,
  resolveCoreHostBootstrapToken,
  writeCoreHostBootstrapFile,
} from "./coreHostBootstrap.js";
import { resolveServerLayout, type ServerLayout } from "./paths.js";

// 版本错配兜底（pre-M2 Supervisor + 新 Core）：Core 另写 0600 run/core-host-bootstrap.json，新 CLI
// 仅在 Supervisor status 缺 secret、且记录与当前 Core 的 generation/pid/host/port 完全一致时合并。
// 见 docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md "Migration and compatibility"。

const posix = process.platform !== "win32";

async function withLayout(run: (layout: ServerLayout) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-core-host-bootstrap-"));
  try {
    await run(resolveServerLayout(join(root, "server")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A ready status as a pre-M2 Supervisor publishes it: Core pid/port/generation, no secret. */
function oldSupervisorStatus(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    ...createStoppedServerStatus("skew-test"),
    state: "ready",
    pid: process.pid,
    host: "127.0.0.1",
    port: 43_210,
    generation: 3,
    startedAt: Date.now(),
    ...overrides,
  };
}

function recordFor(status: ServerStatus, token = createHostBootstrapToken()) {
  return {
    generation: status.generation,
    pid: status.pid!,
    host: status.host!,
    port: status.port!,
    hostBootstrapToken: token,
  };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

function captureIo() {
  let out = "";
  return {
    io: {
      stdout: { write: (value: string) => void (out += value) },
      stderr: { write: () => undefined },
    },
    output: () => out,
  };
}

test("Core writes the record atomically with 0600 file and 0700 runDir (tightening an existing runDir)", async () => {
  await withLayout(async (layout) => {
    await mkdir(layout.runDir, { recursive: true, mode: 0o755 });
    if (posix) await chmod(layout.runDir, 0o755);
    const status = oldSupervisorStatus();
    const record = recordFor(status);
    await writeCoreHostBootstrapFile(layout, record, () => 1234);
    if (posix) {
      assert.equal((await stat(layout.runDir)).mode & 0o777, 0o700);
      assert.equal((await stat(layout.coreHostBootstrapFile)).mode & 0o777, 0o600);
    }
    assert.deepEqual(JSON.parse(await readFile(layout.coreHostBootstrapFile, "utf8")), {
      schemaVersion: 1,
      ...record,
      createdAt: 1234,
    });
    assert.deepEqual(
      (await readdir(layout.runDir)).filter((entry) => entry.endsWith(".tmp")),
      [],
      "no temporary file is left behind after the rename",
    );
    assert.equal(layout.coreHostBootstrapFile, join(layout.runDir, "core-host-bootstrap.json"));
  });
});

test("CLI merge fills the secret only for a matching, live Core when the Supervisor status lacks it", async () => {
  await withLayout(async (layout) => {
    const status = oldSupervisorStatus();
    const record = recordFor(status);
    await writeCoreHostBootstrapFile(layout, record);
    assert.deepEqual(await resolveCoreHostBootstrapToken(status, layout), {
      merged: true,
      hostBootstrapToken: record.hostBootstrapToken,
    });
    const merged = await mergeCoreHostBootstrapToken(status, layout);
    assert.equal(merged.hostBootstrapToken, record.hostBootstrapToken);
    assert.equal(status.hostBootstrapToken, undefined, "the input status is not mutated");
  });
});

test("a Supervisor-provided secret always wins over the Core file", async () => {
  await withLayout(async (layout) => {
    const supervisorToken = createHostBootstrapToken();
    const status = oldSupervisorStatus({ hostBootstrapToken: supervisorToken });
    await writeCoreHostBootstrapFile(layout, recordFor(status));
    assert.deepEqual(await resolveCoreHostBootstrapToken(status, layout), {
      merged: false,
      reason: "supervisor-token",
    });
    assert.equal(
      (await mergeCoreHostBootstrapToken(status, layout)).hostBootstrapToken,
      supervisorToken,
    );
  });
});

test("stale records from another generation, port, host or pid are never merged", async () => {
  await withLayout(async (layout) => {
    const status = oldSupervisorStatus();
    const cases: Array<[string, Partial<ReturnType<typeof recordFor>>]> = [
      ["previous generation", { generation: status.generation - 1 }],
      ["previous port", { port: status.port! + 1 }],
      ["other host", { host: "localhost" }],
      ["previous pid", { pid: status.pid! + 1 }],
    ];
    for (const [label, override] of cases) {
      await writeCoreHostBootstrapFile(layout, { ...recordFor(status), ...override });
      assert.deepEqual(
        await resolveCoreHostBootstrapToken(status, layout),
        { merged: false, reason: "stale-record" },
        label,
      );
      assert.equal(
        (await mergeCoreHostBootstrapToken(status, layout)).hostBootstrapToken,
        undefined,
      );
    }
  });
});

test("a record whose Core pid is dead is ignored even if status still matches it", async () => {
  await withLayout(async (layout) => {
    const status = oldSupervisorStatus({ pid: await deadPid() });
    await writeCoreHostBootstrapFile(layout, recordFor(status));
    assert.deepEqual(await resolveCoreHostBootstrapToken(status, layout), {
      merged: false,
      reason: "core-not-running",
    });
  });
});

test("nothing is merged unless the status describes a ready Core", async () => {
  await withLayout(async (layout) => {
    const ready = oldSupervisorStatus();
    await writeCoreHostBootstrapFile(layout, recordFor(ready));
    for (const state of ["starting", "stopped", "crashed", "updating"] as const) {
      assert.deepEqual(
        await resolveCoreHostBootstrapToken({ ...ready, state }, layout),
        { merged: false, reason: "core-not-ready" },
        state,
      );
    }
    assert.deepEqual(await resolveCoreHostBootstrapToken({ ...ready, pid: null }, layout), {
      merged: false,
      reason: "core-not-ready",
    });
  });
});

test("missing and malformed files are ignored", async () => {
  await withLayout(async (layout) => {
    const status = oldSupervisorStatus();
    assert.deepEqual(await resolveCoreHostBootstrapToken(status, layout), {
      merged: false,
      reason: "file-missing",
    });
    await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
    const malformed = [
      "{not json",
      "null",
      JSON.stringify({
        schemaVersion: 1,
        ...recordFor(status),
        createdAt: 1,
        hostBootstrapToken: "short",
      }),
      JSON.stringify({ schemaVersion: 2, ...recordFor(status), createdAt: 1 }),
      JSON.stringify({ schemaVersion: 1, ...recordFor(status), createdAt: 1, extra: true }),
    ];
    for (const content of malformed) {
      await writeFile(layout.coreHostBootstrapFile, content, { mode: 0o600 });
      if (posix) await chmod(layout.coreHostBootstrapFile, 0o600);
      assert.deepEqual(
        await resolveCoreHostBootstrapToken(status, layout),
        { merged: false, reason: "file-rejected", detail: "malformed" },
        content,
      );
    }
  });
});

test(
  "POSIX: a file that is not exactly 0600, or is a symlink, is rejected",
  { skip: !posix },
  async () => {
    await withLayout(async (layout) => {
      const status = oldSupervisorStatus();
      await writeCoreHostBootstrapFile(layout, recordFor(status));
      for (const mode of [0o644, 0o640, 0o604, 0o660, 0o700, 0o400]) {
        await chmod(layout.coreHostBootstrapFile, mode);
        assert.deepEqual(
          await readCoreHostBootstrapFile(layout.coreHostBootstrapFile),
          { state: "rejected", reason: "insecure-permissions" },
          mode.toString(8),
        );
        assert.equal(
          (await mergeCoreHostBootstrapToken(status, layout)).hostBootstrapToken,
          undefined,
        );
      }
      await chmod(layout.coreHostBootstrapFile, 0o600);
      const target = join(layout.serverRoot, "planted.json");
      await rm(target, { force: true });
      await writeFile(target, await readFile(layout.coreHostBootstrapFile), { mode: 0o600 });
      await rm(layout.coreHostBootstrapFile);
      await symlink(target, layout.coreHostBootstrapFile);
      assert.deepEqual(await readCoreHostBootstrapFile(layout.coreHostBootstrapFile), {
        state: "rejected",
        reason: "not-regular-file",
      });
    });
  },
);

test("Core cleanup removes only its own record, so a newer generation's file survives", async () => {
  await withLayout(async (layout) => {
    const status = oldSupervisorStatus();
    await writeCoreHostBootstrapFile(layout, recordFor(status));
    await removeCoreHostBootstrapFile(layout, {
      generation: status.generation - 1,
      pid: status.pid!,
    });
    await removeCoreHostBootstrapFile(layout, {
      generation: status.generation,
      pid: status.pid! + 1,
    });
    assert.equal((await readCoreHostBootstrapFile(layout.coreHostBootstrapFile)).state, "valid");
    await removeCoreHostBootstrapFile(layout, { generation: status.generation, pid: status.pid! });
    assert.deepEqual(await readCoreHostBootstrapFile(layout.coreHostBootstrapFile), {
      state: "missing",
    });
    await removeCoreHostBootstrapFile(layout, { generation: status.generation, pid: status.pid! });
  });
});

test("`status --json` merges the Core file into a persisted old-Supervisor status; human output redacts it", async () => {
  await withLayout(async (layout) => {
    // 没有 control socket：CLI 走 status.json 回退路径（与旧 Supervisor 落盘格式相同，无 secret）。
    const status = oldSupervisorStatus();
    const record = recordFor(status);
    await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
    await writeFile(layout.statusFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    await writeCoreHostBootstrapFile(layout, record);

    const json = captureIo();
    assert.equal(
      await runServerCli(["status", "--json", "--server-root", layout.serverRoot], json.io),
      0,
    );
    const printed = JSON.parse(json.output()) as ServerStatus;
    assert.equal(printed.hostBootstrapToken, record.hostBootstrapToken);
    assert.equal(printed.generation, status.generation);

    const human = captureIo();
    assert.equal(await runServerCli(["status", "--server-root", layout.serverRoot], human.io), 0);
    assert.ok(
      !human.output().includes(record.hostBootstrapToken),
      "human status never echoes the secret",
    );
    assert.match(human.output(), /\[redacted\]/u);

    // Supervisor 已提供 secret 时 CLI 原样输出，不被文件覆盖。
    const supervisorToken = createHostBootstrapToken();
    await writeFile(
      layout.statusFile,
      `${JSON.stringify({ ...status, hostBootstrapToken: supervisorToken })}\n`,
      { mode: 0o600 },
    );
    const wins = captureIo();
    assert.equal(
      await runServerCli(["status", "--json", "--server-root", layout.serverRoot], wins.io),
      0,
    );
    assert.equal((JSON.parse(wins.output()) as ServerStatus).hostBootstrapToken, supervisorToken);

    // 过期（上一代）记录：CLI 不合并。
    await writeFile(layout.statusFile, `${JSON.stringify({ ...status, generation: 4 })}\n`, {
      mode: 0o600,
    });
    const stale = captureIo();
    assert.equal(
      await runServerCli(["status", "--json", "--server-root", layout.serverRoot], stale.io),
      0,
    );
    assert.equal((JSON.parse(stale.output()) as ServerStatus).hostBootstrapToken, undefined);
  });
});
