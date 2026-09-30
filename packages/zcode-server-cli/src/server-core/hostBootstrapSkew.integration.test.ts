import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ChannelClient, Emitter, SocketProtocol, VSBuffer } from "@zcode/rpc";
import type { IChannel, ISocket } from "@zcode/rpc";
import { IAgentHostService } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import { WebSocket } from "ws";
import { runServerCli } from "../cli.js";
import type { ServerStatus } from "../contracts.js";
import { coreHostBootstrapRecordSchema } from "../runtime/coreHostBootstrap.js";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { Supervisor } from "../supervisor/supervisor.js";

// pre-M2 Supervisor + 新 Core（原地 apply-update）：旧 ready schema 丢弃 hostBootstrapToken，
// Supervisor status 不含 secret。新 Core 另写 0600 run/core-host-bootstrap.json，新 CLI 的
// `status --json` / `serve --daemon --json`（Desktop Main 与 SSH connector 读取的就是后者）合并它，
// 使 Host 仍能换取 ticket 并 attach /ws/host。

const posix = process.platform !== "win32";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function cliJson(argv: readonly string[]): Promise<ServerStatus> {
  let out = "";
  const code = await runServerCli(argv, {
    stdout: { write: (value: string) => void (out += value) },
    stderr: { write: () => undefined },
  });
  assert.equal(code, 0, `zcode ${argv.join(" ")} exits 0 (${out})`);
  return JSON.parse(out) as ServerStatus;
}

async function cliText(argv: readonly string[]): Promise<string> {
  let out = "";
  assert.equal(
    await runServerCli(argv, {
      stdout: { write: (value: string) => void (out += value) },
      stderr: { write: () => undefined },
    }),
    0,
  );
  return out;
}

function postCapability(status: ServerStatus, token?: string): Promise<Response> {
  return fetch(`http://${status.host}:${status.port}/api/rpc-host-capability`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Issues a ticket with the CLI-published secret and opens the trusted `/ws/host` channel. */
async function attachHost(
  status: ServerStatus,
): Promise<{ call<T>(method: string): Promise<T>; dispose(): void }> {
  assert.ok(status.hostBootstrapToken, "CLI status carries a Host bootstrap secret");
  const issued = await postCapability(status, status.hostBootstrapToken);
  assert.equal(issued.status, 200);
  const { capability } = (await issued.json()) as { capability: string };
  const ws = new WebSocket(`ws://${status.host}:${status.port}/ws/host`, {
    headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability },
  });
  const data = new Emitter<VSBuffer>();
  const closed = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => closed.fire());
  ws.on("error", () => closed.fire());
  const socket: ISocket = {
    onData: data.event,
    onClose: closed.event,
    onEnd: closed.event,
    write(buffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
      data.dispose();
      closed.dispose();
    },
  };
  // Protocol must subscribe before the upgrade completes: the server's first frame can arrive
  // right after "open", and an Emitter without listeners drops it (the call would then hang).
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const channel = client.getChannel<IChannel>(IAgentHostService.channelName);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    call: (method) => channel.call(method, []),
    dispose() {
      client.dispose();
      protocol.dispose();
      socket.dispose();
    },
  };
}

test(
  "pre-M2 Supervisor + new Core: CLI-merged secret issues a Host ticket and attaches /ws/host",
  { timeout: 120_000 },
  async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), "zcode-host-bootstrap-skew-")));
    const serverRoot = join(temp, "server");
    const worktreePath = join(temp, "worktree");
    const configPath = join(temp, "provider-config.json");
    await mkdir(worktreePath, { recursive: true });
    await writeFile(configPath, "{}\n");
    const layout = resolveServerLayout(serverRoot);
    // 真实 Supervisor 会给 Core 设置 ZCODE_SERVER_ROOT；Core 用它定位 runDir 并解析安装身份。
    await ensureServerInstallOwnership(layout, "target-skew");
    const coreEntry = fileURLToPath(
      new URL("./fixtures/preM2SupervisorCoreEntry.ts", import.meta.url),
    );
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ZCODE_DATA_BASE_DIR: join(temp, "zcode-data"),
      ZCODE_SERVER_ROOT: serverRoot,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: configPath,
      ZCODE_TEST_AGENT_HOST_ROOT: join(serverRoot, "agent-host", "sessions"),
      ZCODE_TEST_WORKTREE: worktreePath,
      ZCODE_TEST_TARGET_ID: "target-skew",
    };
    const supervisor = new Supervisor({
      layout,
      version: "pre-m2-supervisor-skew-test",
      coreReadyTimeoutMs: 15_000,
      coreStopGraceTimeoutMs: 5_000,
      coreKillTimeoutMs: 2_000,
      launcher: {
        launch(generation) {
          return fork(coreEntry, [String(generation)], {
            cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
            env: childEnv,
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          });
        },
      },
    });
    const previousSkip = process.env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION;
    // `serve --daemon --json` 的 fallback 模式（SSH connector 同款）在已有 ready Supervisor 时直接回显其 status。
    process.env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION = "1";
    let host: Awaited<ReturnType<typeof attachHost>> | undefined;
    try {
      await supervisor.start();
      const ready = await waitFor(
        () => supervisor.status(),
        (status) => status.state === "ready",
        "Core ready",
      );
      // Gap reproduction: the Supervisor (control socket and status.json) has no secret …
      assert.equal(ready.hostBootstrapToken, undefined, "pre-M2 ready schema stripped the secret");
      const persisted = JSON.parse(await readFile(layout.statusFile, "utf8")) as ServerStatus;
      assert.equal(persisted.hostBootstrapToken, undefined);
      assert.equal(
        (await postCapability(ready)).status,
        401,
        "the new Core still enforces the secret",
      );

      // … but the new Core published a matching 0600 record before ready.
      const record = coreHostBootstrapRecordSchema.parse(
        JSON.parse(await readFile(layout.coreHostBootstrapFile, "utf8")),
      );
      assert.equal(record.generation, ready.generation);
      assert.equal(record.pid, ready.pid);
      assert.equal(record.port, ready.port);
      assert.equal(record.host, ready.host);
      if (posix) {
        assert.equal((await stat(layout.coreHostBootstrapFile)).mode & 0o777, 0o600);
        assert.equal((await stat(layout.runDir)).mode & 0o777, 0o700);
      }

      // The new CLI merges it on both paths the Host bootstrap uses.
      const viaStatus = await cliJson(["status", "--json", "--server-root", serverRoot]);
      assert.equal(viaStatus.hostBootstrapToken, record.hostBootstrapToken);
      const viaServe = await cliJson(["serve", "--daemon", "--json", "--server-root", serverRoot]);
      assert.equal(viaServe.state, "ready");
      assert.equal(viaServe.hostBootstrapToken, record.hostBootstrapToken);
      const human = await cliText(["status", "--server-root", serverRoot]);
      assert.ok(
        !human.includes(record.hostBootstrapToken),
        "human-readable status redacts the secret",
      );
      assert.match(human, /\[redacted\]/u);

      host = await attachHost(viaServe);
      // `/ws`（非 Host 通道）上同一调用会得到 Unknown channel；这里能返回说明拿到了可信 Host 通道。
      assert.ok(await host.call("getAvailability"), "trusted Host channel is usable");
      host.dispose();
      host = undefined;

      // A Core crash starts a new generation: the file is replaced, the old secret gets 401.
      const corePid = ready.pid!;
      process.kill(corePid, "SIGKILL");
      const restarted = await waitFor(
        () => supervisor.status(),
        (status) => status.state === "ready" && status.generation > ready.generation,
        "Core restart after crash",
        30_000,
      );
      assert.equal(restarted.hostBootstrapToken, undefined);
      const replaced = coreHostBootstrapRecordSchema.parse(
        JSON.parse(await readFile(layout.coreHostBootstrapFile, "utf8")),
      );
      assert.equal(replaced.generation, restarted.generation);
      assert.equal(replaced.pid, restarted.pid);
      assert.notEqual(replaced.hostBootstrapToken, record.hostBootstrapToken);
      assert.equal((await postCapability(restarted, record.hostBootstrapToken)).status, 401);

      // A stale record from the previous generation/port is never merged (and is useless anyway).
      const current = await readFile(layout.coreHostBootstrapFile, "utf8");
      await writeFile(
        layout.coreHostBootstrapFile,
        `${JSON.stringify({ ...replaced, ...record })}\n`,
        {
          mode: 0o600,
        },
      );
      const withStale = await cliJson(["status", "--json", "--server-root", serverRoot]);
      assert.equal(withStale.generation, restarted.generation);
      assert.equal(
        withStale.hostBootstrapToken,
        undefined,
        "stale generation/port record is ignored",
      );
      await writeFile(layout.coreHostBootstrapFile, current, { mode: 0o600 });

      const afterCrash = await cliJson([
        "serve",
        "--daemon",
        "--json",
        "--server-root",
        serverRoot,
      ]);
      assert.equal(afterCrash.hostBootstrapToken, replaced.hostBootstrapToken);
      host = await attachHost(afterCrash);
      assert.ok(await host.call("getAvailability"));
      host.dispose();
      host = undefined;

      // Clean Core exit removes the file; the stopped status then carries no secret.
      await supervisor.stop();
      await assert.rejects(stat(layout.coreHostBootstrapFile), { code: "ENOENT" });
      const stopped = await cliJson(["status", "--json", "--server-root", serverRoot]);
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.hostBootstrapToken, undefined);
    } finally {
      host?.dispose();
      if (previousSkip === undefined) delete process.env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION;
      else process.env.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION = previousSkip;
      await supervisor.stop().catch(() => undefined);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
