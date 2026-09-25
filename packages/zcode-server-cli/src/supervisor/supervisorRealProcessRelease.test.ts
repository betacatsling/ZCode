import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stageRelease } from "../packaging/stage.js";
import { ReleaseInstaller } from "../runtime/releaseInstaller.js";
import { currentServerTarget } from "../runtime/manifest.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createReleaseAgentWiring } from "../runtime/agentWiring.js";
import { requestControl } from "../ipc/controlClient.js";
import { DataRootLock } from "../runtime/lock.js";
import { Supervisor } from "./supervisor.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function workspacePackages(): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const root of [join(repo, "apps/zcode-cli/packages"), join(repo, "packages")]) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      try {
        const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
          name?: string;
        };
        if (value.name) entries.set(value.name, directory);
      } catch {
        /* directory without package manifest */
      }
    }
  }
  return entries;
}

test(
  "local source Core/CLI/Node executable release is staged, installed, and booted",
  { timeout: 300_000 },
  async () => {
    // 中文：macOS UNIX socket 路径长度有上限；测试 profile 前缀保持短且独立。
    const dir = await mkdtemp(join(tmpdir(), "sr-"));
    const layout = resolveServerLayout(join(dir, "install"));
    const dist = join(repo, "packages/zcode-server-cli/dist");
    const agent = join(repo, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
    const paths = [
      join(dist, "server-cli.js"),
      join(dist, "server-core.js"),
      join(dist, "piWorker.js"),
      agent,
      process.execPath,
    ];
    let core: ChildProcess | undefined;
    let coreClosed: Promise<void> | undefined;
    try {
      for (const path of paths) await access(path); // no empty or synthetic Core fallback
      assert.equal(process.version, "v24.14.0");
      const sourceHashes = await Promise.all(paths.map(hash));
      const target = currentServerTarget();
      const staged = await stageRelease({
        target,
        appVersion: "local-source-a",
        distDir: dist,
        agentBundlePath: agent,
        nodeBinaryPath: process.execPath,
        workspaceNodeModulesDir: join(repo, "node_modules"),
        workspacePackageDirs: await workspacePackages(),
        outputDir: join(dir, "stage"),
        notices: {
          thirdParty: await readFile(join(repo, "NOTICE.md"), "utf8"),
          node: "LOCAL TEST ONLY: pinned Node 24.14.0, not a published release notice",
          nodeSource:
            "LOCAL TEST ONLY: process.execPath from mise; provenance is not official distribution certification",
        },
      });
      assert.ok(staged.archivePath);
      const installer = new ReleaseInstaller(layout);
      const archiveSha256 = await hash(staged.archivePath);
      const manifest = await installer.installArchive({
        archivePath: staged.archivePath,
        target,
        version: "local-source-a",
        archiveSha256,
      });
      const releases = new ReleaseManager(layout);
      assert.deepEqual(await releases.readPending(), manifest);
      assert.equal(manifest.archiveSha256, archiveSha256);
      assert.equal(
        manifest.components?.some((component) => component.id === "server-runtime"),
        true,
      );
      // Actual generated server-core.js has require2("node-pty/lib/utils"); alias must not be omitted.
      assert.equal(
        (
          await stat(join(manifest.releaseDir, "runtime/node_modules/node-pty/package.json"))
        ).isFile(),
        true,
      );
      const consumed = [
        "runtime/server-cli.js",
        "runtime/server-core.js",
        "runtime/piWorker.js",
        "runtime/zcode.cjs",
        "runtime/node",
      ];
      for (let index = 0; index < consumed.length; index++) {
        const file = join(manifest.releaseDir, consumed[index]!);
        assert.equal((await stat(file)).isFile(), true);
        assert.equal(await hash(file), sourceHashes[index]);
      }
      await releases.applyPendingWithTransaction(null);
      assert.deepEqual(await releases.readCurrentForExecution(), manifest);
      await releases.completeUpdate();
      assert.equal(
        await stat(layout.updateTransactionFile).then(
          () => true,
          () => false,
        ),
        false,
      );
      const runtime = join(manifest.releaseDir, "runtime");
      const provider = join(dir, "builtin.json");
      await writeFile(
        provider,
        JSON.stringify({
          schemaVersion: 1,
          revision: 0,
          config: {
            providerConfigRules: { templateRules: [], providerRules: [] },
            modelConfigRules: {
              modelRules: [],
              modelApiRules: [],
              providerSiteRules: [],
              templateModelRules: [],
              builtinProviderModelRules: [],
            },
          },
        }),
      );
      const runtimeNode = join(runtime, "node");
      core = fork(join(runtime, "server-core.js"), ["1", "open"], {
        execPath: runtimeNode,
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, "config"),
          ZCODE_DATA_BASE_DIR: dir,
          ZCODE_SERVER_ROOT: layout.serverRoot,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
          ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
          ...createReleaseAgentWiring(runtime, runtimeNode, {}),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      coreClosed = new Promise<void>((resolve) => core!.once("close", () => resolve()));
      let stderr = "";
      core.stderr?.on("data", (part: Buffer) => {
        stderr += part.toString().replaceAll(dir, "<profile>");
      });
      const result = await new Promise<Record<string, unknown>>((resolveResult, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`installed Core ready timeout: ${stderr}`)),
          25_000,
        );
        core!.on("message", (message: Record<string, unknown>) => {
          if (message.type === "ready" || message.type === "fatal") {
            clearTimeout(timer);
            resolveResult(message);
          }
        });
        core!.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`installed Core closed ${code}: ${stderr}`));
        });
      });
      assert.equal(result.type, "ready", JSON.stringify(result));
      assert.equal(result.generation, 1);
      assert.equal(result.bootLeaseId, undefined);
      async function maintenance(
        command: "maintenance-begin" | "maintenance-release",
        leaseId?: string,
      ) {
        const requestId = randomUUID();
        const reply = new Promise<Record<string, unknown>>((resolveReply, reject) => {
          const timer = setTimeout(() => {
            core?.off("message", onMessage);
            reject(new Error(`installed maintenance timeout: ${stderr}`));
          }, 5_000);
          function onMessage(message: Record<string, unknown>) {
            if (message.type !== "maintenance" || message.requestId !== requestId) return;
            clearTimeout(timer);
            core?.off("message", onMessage);
            resolveReply(message);
          }
          core!.on("message", onMessage);
        });
        core!.send({ command, requestId, ...(leaseId ? { leaseId } : {}) });
        return await reply;
      }
      const begin = await maintenance("maintenance-begin");
      assert.ok(begin.leaseId, JSON.stringify(begin));
      assert.deepEqual(begin.nativeActivity, { running: 0, waiting: 0, uncertain: 0 });
      assert.deepEqual(begin.externalActivity, { running: 0, waiting: 0, uncertain: 0 });
      const released = await maintenance("maintenance-release", String(begin.leaseId));
      assert.equal(released.leaseId, begin.leaseId);
      core.send({ command: "shutdown" });
      await coreClosed;
      assert.equal(core.exitCode, 0);

      // 中文：独立 Core freeze 正常并不证明 Supervisor 的 IPC、current 选择和收口顺序。
      // 用相同的已安装可执行文件重新启动实际 Supervisor，经控制 socket 受理一次
      // 新的原生/外部 census 并释放同一租约，再核验 child close、锁和 socket。
      const launched: ChildProcess[] = [];
      const launchedClosed: Promise<void>[] = [];
      const supervisor = new Supervisor({
        layout,
        version: manifest.version,
        coreReadyTimeoutMs: 25_000,
        launcher: {
          launch(generation, release, bootMode) {
            assert.equal(release?.releaseDir, manifest.releaseDir);
            assert.equal(bootMode, "open");
            const child = fork(join(runtime, "server-core.js"), [String(generation), bootMode], {
              execPath: runtimeNode,
              env: {
                ...process.env,
                HOME: dir,
                XDG_CONFIG_HOME: join(dir, "config"),
                ZCODE_DATA_BASE_DIR: dir,
                ZCODE_SERVER_ROOT: layout.serverRoot,
                ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
                ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
                ...createReleaseAgentWiring(runtime, runtimeNode, {}),
              },
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            });
            launched.push(child);
            launchedClosed.push(
              new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed())),
            );
            return child;
          },
        },
      });
      try {
        await supervisor.start();
        const deadline = Date.now() + 25_000;
        while (supervisor.status().state !== "ready" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        assert.equal(supervisor.status().state, "ready");
        const live = await requestControl(layout.controlEndpoint, { command: "status" });
        assert.equal((live as { pid: number }).pid, launched[0]?.pid);
        assert.deepEqual(
          await requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
          { ready: true },
        );
        assert.deepEqual(
          await requestControl(layout.controlEndpoint, { command: "end-fallback-migration" }),
          { released: true },
        );
      } finally {
        try {
          await supervisor.stop("installed-real-process-cleanup");
        } finally {
          // 中文：即使 Supervisor 收口失败，fixture 只回收自己 fork 的 Core，
          // 等待实际 close 后才删除隔离 profile；不能把 kill 的发出当作终态。
          for (const [index, child] of launched.entries()) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            const close = launchedClosed[index]!;
            let ended = await Promise.race([
              close.then(() => true),
              new Promise<false>((resolveTimeout) =>
                setTimeout(() => resolveTimeout(false), 2_000),
              ),
            ]);
            if (!ended) {
              child.kill("SIGKILL");
              ended = await Promise.race([
                close.then(() => true),
                new Promise<false>((resolveTimeout) =>
                  setTimeout(() => resolveTimeout(false), 2_000),
                ),
              ]);
            }
            assert.equal(
              ended,
              true,
              "owned installed Core child must close before profile removal",
            );
          }
        }
      }
      assert.equal(launched.length, 1);
      assert.equal(launched[0]!.exitCode, 0);
      assert.equal(supervisor.status().state, "stopped");
      assert.deepEqual(await new DataRootLock(layout.lockFile).inspect(), { state: "missing" });
      await assert.rejects(requestControl(layout.controlEndpoint, { command: "status" }));
    } finally {
      if (core && core.exitCode === null) core.kill("SIGTERM");
      if (core && coreClosed) {
        const settled = await Promise.race([
          coreClosed.then(() => true),
          new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2000)),
        ]);
        if (!settled) {
          core.kill("SIGKILL");
          await coreClosed;
        }
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  },
);
