import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stageRelease } from "../packaging/stage.js";
import { ReleaseInstaller } from "../runtime/releaseInstaller.js";
import { currentServerTarget } from "../runtime/manifest.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { hashReleaseTree } from "../runtime/immutableRelease.js";
import {
  registerTrustedLocalSourceBootSelection,
  verifyTrustedLocalSourceBootSelection,
} from "../runtime/releaseBootSelection.js";
import { createReleaseAgentWiring } from "../runtime/agentWiring.js";
import { requestControl } from "../ipc/controlClient.js";
import { DataRootLock } from "../runtime/lock.js";
import { Supervisor } from "./supervisor.js";
import { isolatedReleaseEnv } from "./supervisorRealProcessEnv.fixture.js";
import { connectInstalledHost } from "./installedHostIngress.fixture.js";
import { createInstalledHostModel } from "./installedHostModel.fixture.js";

const git = promisify(execFile);

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
    // 中文：真实 Agent 在 TMPDIR 下建 znr-UUID.sock；macOS 的长 per-user
    // tmpdir + 隔离 profile + /tmp 会超出 UNIX socket 路径上限而 EINVAL 秒退。
    // /tmp 是短基目录，每次只创建/清理本测试专有的 sr-* profile。
    const dir = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "sr-"));
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
    let fixtureModel: Awaited<ReturnType<typeof createInstalledHostModel>> | undefined;
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
      const poisonedPath = join(dir, "poisoned-path");
      await mkdir(poisonedPath, { recursive: true });
      await mkdir(join(dir, "tmp"), { recursive: true });
      const poisonMarker = join(dir, "inherited-node-options-used");
      const pathMarker = join(dir, "inherited-path-used");
      const preload = join(poisonedPath, "preload.cjs");
      await writeFile(
        preload,
        `require("node:fs").writeFileSync(${JSON.stringify(poisonMarker)}, "executed")`,
      );
      const poisonedNode = join(poisonedPath, process.platform === "win32" ? "node.cmd" : "node");
      await writeFile(
        poisonedNode,
        `#!/bin/sh\nprintf 'executed' > ${JSON.stringify(pathMarker)}\nexit 93\n`,
      );
      if (process.platform !== "win32") await chmod(poisonedNode, 0o755);
      // 只构造无凭据的合成父环境；测试证明所选 installed processes 不会跑
      // 继承的 preload/PATH 伪装，真正的 Node/Agent 都走安装归档内绝对路径。
      const isolatedEnv = isolatedReleaseEnv(
        {
          NODE_OPTIONS: `--require=${preload}`,
          PATH: `${poisonedPath}:${process.env.PATH ?? ""}`,
          ZCODE_MEMORY_HEAVY_SLOT_OWNER: process.env.ZCODE_MEMORY_HEAVY_SLOT_OWNER,
        },
        dir,
        provider,
      );
      // 中文：隔离环境下 Core 的 stdout_closed 只说明 Agent 管道断开，
      // 不能推断是 idle。先对同一安装包 Node/Agent 执行有界独立探测，
      // 从 stderr/退出状态定位依赖，所有子进程在下一步前必须 close。
      const agentProbe = spawn(runtimeNode, [join(runtime, "zcode.cjs"), "app-server", "--stdio"], {
        cwd: dir,
        env: isolatedEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let agentProbeStderr = "";
      agentProbe.stderr.on("data", (part: Buffer) => {
        agentProbeStderr += part.toString().replaceAll(dir, "<profile>").slice(0, 4096);
      });
      const probeClosed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolveClosed) =>
          agentProbe.once("close", (code, signal) => resolveClosed({ code, signal })),
      );
      try {
        const earlyExit = await Promise.race([
          probeClosed,
          new Promise<null>((resolveDelay) => setTimeout(() => resolveDelay(null), 4_000)),
        ]);
        assert.equal(
          earlyExit,
          null,
          `installed Agent exited: ${JSON.stringify(earlyExit)} stderr=${agentProbeStderr}`,
        );
      } finally {
        agentProbe.stdin.end();
        const settled = await Promise.race([
          probeClosed.then(() => true),
          new Promise<false>((resolveDelay) => setTimeout(() => resolveDelay(false), 2_000)),
        ]);
        if (!settled) agentProbe.kill("SIGTERM");
        const ended = await Promise.race([
          probeClosed.then(() => true),
          new Promise<false>((resolveDelay) => setTimeout(() => resolveDelay(false), 2_000)),
        ]);
        if (!ended) agentProbe.kill("SIGKILL");
        assert.ok(
          await Promise.race([
            probeClosed.then(() => true),
            new Promise<false>((resolveDelay) => setTimeout(() => resolveDelay(false), 2_000)),
          ]),
          "installed Agent diagnostic child must close",
        );
      }
      assert.equal(isolatedEnv.NODE_OPTIONS, "--max-old-space-size=2048");
      assert.ok(!isolatedEnv.PATH?.includes(poisonedPath));
      assert.equal(
        isolatedEnv.ZCODE_MEMORY_HEAVY_SLOT_OWNER,
        process.env.ZCODE_MEMORY_HEAVY_SLOT_OWNER,
      );
      core = fork(join(runtime, "server-core.js"), ["1", "open"], {
        execPath: runtimeNode,
        execArgv: [],
        cwd: dir,
        env: {
          ...isolatedEnv,
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
      assert.ok(begin.leaseId, JSON.stringify({ reply: begin, stderr }));
      assert.deepEqual(begin.nativeActivity, { running: 0, waiting: 0, uncertain: 0 });
      assert.deepEqual(begin.externalActivity, { running: 0, waiting: 0, uncertain: 0 });
      const released = await maintenance("maintenance-release", String(begin.leaseId));
      assert.equal(released.leaseId, begin.leaseId);
      core.send({ command: "shutdown" });
      await coreClosed;
      assert.equal(core.exitCode, 0);

      // Only this current-checkout Agent bundle is known to implement constructor-held
      // Inbox + real native/boot/claim. An arbitrary older archive must never inherit this
      // test-only declaration from the Supervisor production release wiring.
      core = fork(join(runtime, "server-core.js"), ["2", "held"], {
        execPath: runtimeNode,
        execArgv: [],
        cwd: dir,
        env: {
          ...isolatedEnv,
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, "config"),
          ZCODE_DATA_BASE_DIR: dir,
          ZCODE_SERVER_ROOT: layout.serverRoot,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
          ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
          ...createReleaseAgentWiring(runtime, runtimeNode, {}),
          ZCODE_AGENT_SERVER_BOOT_FENCE_V1: "1",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      coreClosed = new Promise<void>((resolveClosed) => core!.once("close", () => resolveClosed()));
      let heldStderr = "";
      core.stderr?.on("data", (part: Buffer) => {
        heldStderr += part.toString().replaceAll(dir, "<profile>");
      });
      const heldReady = await new Promise<Record<string, unknown>>((resolveReady, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`held Core ready timeout: ${heldStderr}`)),
          25_000,
        );
        core!.on("message", (message: Record<string, unknown>) => {
          if (message.type === "ready" || message.type === "fatal") {
            clearTimeout(timer);
            resolveReady(message);
          }
        });
        core!.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`held Core closed ${code}: ${heldStderr}`));
        });
      });
      assert.equal(heldReady.type, "ready", JSON.stringify(heldReady));
      assert.equal(heldReady.generation, 2);
      assert.ok(heldReady.bootLeaseId, "real constructor hold must return an actual boot lease");
      const wrong = await maintenance("maintenance-release", randomUUID());
      assert.equal(wrong.leaseId, undefined, "a wrong token cannot open held Core");
      const opened = await maintenance("maintenance-release", String(heldReady.bootLeaseId));
      assert.equal(opened.leaseId, heldReady.bootLeaseId);
      const freshAfterOpen = await maintenance("maintenance-begin");
      assert.ok(freshAfterOpen.leaseId);
      assert.deepEqual(freshAfterOpen.nativeActivity, { running: 0, waiting: 0, uncertain: 0 });
      assert.deepEqual(freshAfterOpen.externalActivity, { running: 0, waiting: 0, uncertain: 0 });
      assert.equal(
        (await maintenance("maintenance-release", String(freshAfterOpen.leaseId))).leaseId,
        freshAfterOpen.leaseId,
      );
      core.send({ command: "shutdown" });
      await coreClosed;
      assert.equal(core.exitCode, 0);

      const stagedCandidate = await stageRelease({
        target,
        appVersion: "local-source-b",
        distDir: dist,
        agentBundlePath: agent,
        nodeBinaryPath: process.execPath,
        workspaceNodeModulesDir: join(repo, "node_modules"),
        workspacePackageDirs: await workspacePackages(),
        outputDir: join(dir, "candidate-stage"),
        notices: {
          thirdParty: await readFile(join(repo, "NOTICE.md"), "utf8"),
          node: "LOCAL TEST ONLY: pinned Node 24.14.0, not a published release notice",
          nodeSource: "LOCAL TEST ONLY: source-paired Node; no official distribution certification",
        },
      });
      assert.ok(stagedCandidate.archivePath);
      const candidateSha256 = await hash(stagedCandidate.archivePath);
      const candidate = await installer.installArchive({
        archivePath: stagedCandidate.archivePath,
        target,
        version: "local-source-b",
        archiveSha256: candidateSha256,
      });
      assert.notEqual(candidate.releaseDir, manifest.releaseDir);
      assert.deepEqual(await releases.readCurrentForExecution(), manifest);
      assert.deepEqual(await releases.readPending(), candidate);
      for (let index = 0; index < consumed.length; index++) {
        assert.equal(
          await hash(join(candidate.releaseDir, consumed[index]!)),
          sourceHashes[index],
          `candidate runtime component ${consumed[index]} must match its own staged source`,
        );
      }

      // 中文：受管 Core 的配置根固定为 getAppConfigDir(layout.dataBaseDir)（与 cli.ts
      // 生产 launcher 契约一致），fixture provider_config.json 必须写入子进程实际
      // 读取的同一命名空间，否则 host.create 得到 provider-not-found。
      fixtureModel = await createInstalledHostModel(layout.dataBaseDir);
      // 中文：独立 Core freeze 正常并不证明 Supervisor 的 IPC、current 选择和收口顺序。
      // 用已安装可执行文件重新启动实际 Supervisor，经控制 socket 受理一次
      // 新的原生/外部 census 并释放同一租约，再核验 child close、锁和 socket。
      const launched: ChildProcess[] = [];
      const launchedClosed: Promise<void>[] = [];
      let installedCoreEndpoint: { host: string; port: number } | undefined;
      let installedSpec: SessionSpecV2 | undefined;
      const supervisor = new Supervisor({
        layout,
        version: manifest.version,
        coreReadyTimeoutMs: 25_000,
        launcher: {
          launch(generation, release, bootMode) {
            assert.equal(
              release?.releaseDir,
              generation === 1 ? manifest.releaseDir : candidate.releaseDir,
            );
            const selectedRuntime = join(release!.releaseDir, "runtime");
            const selectedNode = join(selectedRuntime, "node");
            const child = fork(
              join(selectedRuntime, "server-core.js"),
              [String(generation), bootMode],
              {
                execPath: selectedNode,
                execArgv: [],
                cwd: dir,
                env: {
                  ...isolatedEnv,
                  HOME: dir,
                  XDG_CONFIG_HOME: join(dir, "config"),
                  // 中文：Supervisor 的 occupancy 恢复扫描固定在
                  // getAppConfigDir(layout.dataBaseDir)；launcher 契约（与 cli.ts
                  // 生产路径一致）要求子进程 ZCODE_DATA_BASE_DIR 恒等于它。
                  ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
                  ZCODE_SERVER_ROOT: layout.serverRoot,
                  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
                  ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
                  ZCODE_MULTI_HARNESS_ENABLED: "1",
                  ...createReleaseAgentWiring(selectedRuntime, selectedNode, {}),
                  // Scope declaration to the locally rebuilt paired candidate; claimBoot must
                  // still prove the actual boot lease. Production default wiring omits this flag.
                  ZCODE_AGENT_SERVER_BOOT_FENCE_V1: bootMode === "held" ? "1" : undefined,
                },
                stdio: ["ignore", "ignore", "pipe", "ipc"],
              },
            );
            child.on("message", (value: { type?: string; host?: string; port?: number }) => {
              if (
                value.type === "ready" &&
                value.host &&
                value.port &&
                (generation === 1 || generation === 3)
              )
                installedCoreEndpoint = { host: value.host, port: value.port };
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
        assert.ok(installedCoreEndpoint, "selected installed Core did not advertise HTTP ingress");
        const ingress = await connectInstalledHost(
          installedCoreEndpoint.host,
          installedCoreEndpoint.port,
        );
        try {
          const availability = await ingress.host.getAvailability();
          assert.equal(availability.admissionEnabled, true);
          assert.deepEqual(availability.harnesses, ["pi"]);
          // 中文：只有安装 Core 公共 Host 入口读取的真实 Catalog/Target 可以授权后续
          // accepted command；这里不把 capability、feature flag 或 Git 初始化当作活动。
          const worktree = join(dir, "host-worktree");
          await mkdir(worktree);
          await git("git", ["-C", worktree, "init", "-q"]);
          await git("git", [
            "-C",
            worktree,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "initial",
          ]);
          await ingress.catalog.importProject({
            id: "p",
            bindingId: "b",
            targetId: availability.target.id,
            name: "Fixture",
            repositoryPath: worktree,
          });
          const workspace = await ingress.catalog.adopt({
            bindingId: "b",
            workspaceId: "w",
            title: "Main",
            worktreePath: worktree,
          });
          assert.equal(workspace.id, "w");
          const spec: SessionSpecV2 = {
            schemaVersion: 2,
            projectId: "p",
            workspaceId: workspace.id,
            hostSessionId: "installed-host-running",
            execution: {
              targetId: availability.target.id,
              workspaceIdentity: workspace.workspaceIdentity,
              worktreePath: workspace.worktreePath,
              worktreeGeneration: workspace.worktreeGeneration,
              cwdRelativeToWorktree: ".",
            },
            harness: { id: "pi", adapterVersion: "0.87.1" },
            modelBinding: {
              kind: "host-managed",
              selection: {
                providerId: "fixture-local",
                modelId: "fixture-model",
                options: { reasoningLevel: "off" },
              },
            },
          };
          installedSpec = spec;
          await ingress.host.create(spec, "installed-create");
          const receipt = await ingress.host.dispatch(spec, {
            type: "send",
            commandId: "installed-turn",
            hostSessionId: spec.hostSessionId,
            turnId: "turn-1",
            text: "Read the fixture",
          });
          assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
          assert.ok(fixtureModel);
          await Promise.race([
            fixtureModel.requestSeen,
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("accepted Host turn never reached loopback fake model")),
                12_000,
              ),
            ),
          ]);
          assert.equal((await ingress.host.getSessionReadModel(spec)).activity, "running");
          assert.ok((await ingress.host.getRuntimeActivity()).running > 0);
          const oldStatus = supervisor.status();
          // 中文：Core 原有协调器先执行真实 native+Host census；busy 时在签发
          // lease 前拒绝。Supervisor 收不到 lease 必须 fail closed，不能凭心跳推进 stop。
          await assert.rejects(
            requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
            /Cannot confirm maintenance admission fence; Core remains unsafe/,
          );
          assert.equal(supervisor.status().state, "ready");
          assert.equal(supervisor.status().pid, oldStatus.pid);
          assert.equal(supervisor.status().generation, oldStatus.generation);
          assert.equal(launched.length, 1, "busy refusal cannot spawn candidate");
          assert.equal(launched[0]?.exitCode, null, "busy refusal cannot stop accepted owner");
          assert.deepEqual(await releases.readCurrentForExecution(), manifest);
          assert.deepEqual(await releases.readPending(), candidate);
          assert.equal(
            await stat(layout.updateTransactionFile).then(
              () => true,
              () => false,
            ),
            false,
          );
          assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");
          const snapshot = await ingress.host.snapshot(spec);
          const cancel = await ingress.host.dispatch(spec, {
            type: "cancelTurn",
            commandId: "installed-cancel",
            hostSessionId: spec.hostSessionId,
            runtimeEpoch: snapshot.logEpoch,
            turnId: "turn-1",
          });
          assert.ok(["accepted", "completed"].includes(cancel.status), JSON.stringify(cancel));
          const drainedBy = Date.now() + 12_000;
          while ((await ingress.host.getRuntimeActivity()).running > 0 && Date.now() < drainedBy)
            await new Promise((resolve) => setTimeout(resolve, 40));
          assert.deepEqual(await ingress.host.getRuntimeActivity(), {
            running: 0,
            waiting: 0,
            uncertain: 0,
          });
          process.stdout.write(
            "installed Host accepted running turn; Core rejected pre-lease busy census, nonforce refused before stop/spawn/pointer, real cancel drained\n",
          );
          fixtureModel.sendWriteCallOnNextRequest();
          const waitingReceipt = await ingress.host.dispatch(spec, {
            type: "send",
            commandId: "installed-wait",
            hostSessionId: spec.hostSessionId,
            turnId: "turn-wait",
            text: "Try writing a file, but wait for approval",
          });
          assert.equal(waitingReceipt.status, "accepted", JSON.stringify(waitingReceipt));
          const waitingBy = Date.now() + 12_000;
          let approval = (await ingress.host.eventsSince(spec, 0)).find(
            (event) => event.kind === "interaction.requested" && event.turnId === "turn-wait",
          );
          while (!approval && Date.now() < waitingBy) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            approval = (await ingress.host.eventsSince(spec, 0)).find(
              (event) => event.kind === "interaction.requested" && event.turnId === "turn-wait",
            );
          }
          assert.ok(
            approval && approval.kind === "interaction.requested",
            "real Pi write approval not committed",
          );
          assert.equal((await ingress.host.getSessionReadModel(spec)).activity, "waiting");
          assert.ok((await ingress.host.getRuntimeActivity()).waiting > 0);
          await assert.rejects(
            requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
            /Cannot confirm maintenance admission fence; Core remains unsafe/,
          );
          assert.equal(supervisor.status().state, "ready");
          assert.equal(supervisor.status().pid, oldStatus.pid);
          assert.equal(supervisor.status().generation, oldStatus.generation);
          assert.equal(launched.length, 1);
          assert.equal(launched[0]?.exitCode, null);
          assert.equal((await ingress.host.getSessionReadModel(spec)).activity, "waiting");
          assert.deepEqual(await releases.readCurrentForExecution(), manifest);
          assert.deepEqual(await releases.readPending(), candidate);
          assert.equal(
            await stat(layout.updateTransactionFile).then(
              () => true,
              () => false,
            ),
            false,
          );
          assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");
          await assert.rejects(access(join(worktree, "unapproved.txt")), { code: "ENOENT" });
          const waitingSnapshot = await ingress.host.snapshot(spec);
          const denial = await ingress.host.dispatch(spec, {
            type: "resolveInteraction",
            commandId: "installed-deny",
            hostSessionId: spec.hostSessionId,
            runtimeEpoch: waitingSnapshot.logEpoch,
            turnId: "turn-wait",
            interactionId: approval.interactionId,
            decision: "deny",
          });
          assert.ok(["accepted", "completed"].includes(denial.status), JSON.stringify(denial));
          await ingress.host.dispatch(spec, {
            type: "cancelTurn",
            commandId: "installed-wait-cancel",
            hostSessionId: spec.hostSessionId,
            runtimeEpoch: waitingSnapshot.logEpoch,
            turnId: "turn-wait",
          });
          const waitingDrainedBy = Date.now() + 12_000;
          while (
            Date.now() < waitingDrainedBy &&
            Object.values(await ingress.host.getRuntimeActivity()).some((count) => count > 0)
          )
            await new Promise((resolve) => setTimeout(resolve, 40));
          assert.deepEqual(await ingress.host.getRuntimeActivity(), {
            running: 0,
            waiting: 0,
            uncertain: 0,
          });
          await assert.rejects(access(join(worktree, "unapproved.txt")), { code: "ENOENT" });
          process.stdout.write(
            "installed Host accepted waiting write; Core refused nonforce before stop/spawn/pointer; exact denial and cancel drained\n",
          );
        } finally {
          await ingress.close();
        }
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
        assert.deepEqual(
          await requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
          { applied: true, version: "local-source-b" },
        );
        assert.equal(supervisor.status().state, "ready");
        assert.equal(supervisor.status().generation, 2);
        assert.equal(supervisor.status().pid, launched[1]?.pid);
        assert.equal(
          launched[0]?.exitCode,
          0,
          "old installed Core must terminate before candidate opens",
        );
        assert.deepEqual(await releases.readCurrentForExecution(), candidate);
        assert.equal(await releases.readPending(), null);
        assert.equal(
          await stat(layout.updateTransactionFile).then(
            () => true,
            () => false,
          ),
          false,
        );
        // RED probe is opt-in while Core's profile writer deliberately forbids unattended
        // stale-owner recovery. Keep the previously passing installed lifecycle suite runnable;
        // never present that default run as unknown-state acceptance.
        if (process.env.ZCODE_SUPERVISOR_UNCERTAIN_PROBE === "1") {
          assert.ok(installedSpec && fixtureModel);
          await releases.writePending(manifest);
          const active = launched[1]!;
          const activeStatus = supervisor.status();
          assert.equal(active.pid, activeStatus.pid);
          assert.equal(active.exitCode, null);
          const resumed = await connectInstalledHost(activeStatus.host!, activeStatus.port!);
          try {
            // 中文：A→B 正常更新已终止原挂载；B 先显式 attach 冷历史，再受理下一轮。
            // 把冷会话未挂载错误当作不确定态会掩盖真正接受后的故障边界。
            await resumed.host.attach(installedSpec);
            assert.equal((await resumed.host.getSessionReadModel(installedSpec)).activity, "idle");
            const accepted = await resumed.host.dispatch(installedSpec, {
              type: "send",
              commandId: "installed-uncertain",
              hostSessionId: installedSpec.hostSessionId,
              turnId: "turn-uncertain",
              text: "Hold the third request before owned Core crash",
            });
            assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
            const requestDeadline = Date.now() + 12_000;
            while (fixtureModel.requestCount() < 3 && Date.now() < requestDeadline)
              await new Promise((resolve) => setTimeout(resolve, 40));
            assert.equal(
              fixtureModel.requestCount(),
              3,
              "accepted third turn reached loopback Model",
            );
            assert.equal(
              (await resumed.host.getSessionReadModel(installedSpec)).activity,
              "running",
            );
            // 中文：只能对本 fixture 保留的已安装 Core ChildProcess 发信号；Pi 是 Core 内线程。
            // RPC 断线本身不是未知证据：等待旧代际真正 close，再读新代际持久 Host journal。
            assert.equal(active.kill("SIGKILL"), true);
            const closed = await Promise.race([
              launchedClosed[1]!.then(() => true),
              new Promise<false>((resolveTimeout) =>
                setTimeout(() => resolveTimeout(false), 12_000),
              ),
            ]);
            assert.equal(closed, true, "owned installed Core must actually close before recovery");
            const recoveryDeadline = Date.now() + 25_000;
            while (
              (supervisor.status().state !== "ready" || supervisor.status().generation !== 3) &&
              Date.now() < recoveryDeadline
            )
              await new Promise((resolve) => setTimeout(resolve, 40));
            assert.equal(
              supervisor.status().state,
              "ready",
              "managed Core recovery did not complete",
            );
            assert.equal(supervisor.status().generation, 3);
            assert.equal(supervisor.status().pid, launched[2]?.pid);
            assert.notEqual(supervisor.status().pid, activeStatus.pid);
            assert.ok(installedCoreEndpoint);
            const recovered = await connectInstalledHost(
              installedCoreEndpoint.host,
              installedCoreEndpoint.port,
            );
            try {
              const durable = await recovered.host.queryCommand(
                installedSpec,
                "installed-uncertain",
              );
              assert.ok(durable, "accepted send receipt must survive Core crash");
              assert.equal(
                (await recovered.host.getSessionReadModel(installedSpec)).activity,
                "uncertain",
              );
              assert.ok((await recovered.host.getRuntimeActivity()).uncertain > 0);
              const duplicate = await recovered.host.queryCommand(
                installedSpec,
                "installed-uncertain",
              );
              assert.deepEqual(duplicate, durable, "repeat query reads the same durable receipt");
              // 冷历史未挂载时直接 send 只会得到 not-attached，而非证明未知命令门禁。
              await recovered.host.attach(installedSpec);
              assert.equal(
                (await recovered.host.getSessionReadModel(installedSpec)).activity,
                "uncertain",
              );
              const next = await recovered.host.dispatch(installedSpec, {
                type: "send",
                commandId: "installed-after-uncertain",
                hostSessionId: installedSpec.hostSessionId,
                turnId: "turn-after-uncertain",
                text: "Must not reach model after crash",
              });
              assert.notEqual(next.status, "accepted", JSON.stringify(next));
              const recoveredStatus = supervisor.status();
              await assert.rejects(
                requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
                /Active or uncertain tasks require --force for update|Cannot confirm maintenance admission fence; Core remains unsafe/,
              );
              assert.equal(supervisor.status().state, "ready");
              assert.equal(supervisor.status().generation, recoveredStatus.generation);
              assert.equal(supervisor.status().pid, recoveredStatus.pid);
              assert.equal(launched.length, 3, "uncertain refusal cannot spawn a candidate");
              assert.equal(
                launched[2]?.exitCode,
                null,
                "uncertain refusal cannot stop recovered Core",
              );
              assert.deepEqual(await releases.readCurrentForExecution(), candidate);
              assert.deepEqual(await releases.readPending(), manifest);
              assert.equal(
                await stat(layout.updateTransactionFile).then(
                  () => true,
                  () => false,
                ),
                false,
              );
              assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");
              assert.equal(
                fixtureModel.requestCount(),
                3,
                "recovery, queries and blocked command must not resend",
              );
              process.stdout.write(
                "installed Host durable unknown after owned Core SIGKILL and managed replacement; nonforce refused with unchanged owner/pointers/lock, no Model resend\n",
              );
            } finally {
              await recovered.close();
            }
          } finally {
            await resumed.close();
          }
        }
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
      if (process.env.ZCODE_SUPERVISOR_UNCERTAIN_PROBE === "1") {
        assert.equal(launched.length, 3);
        assert.equal(launched[0]!.exitCode, 0);
        assert.equal(launched[1]!.signalCode, "SIGKILL");
        assert.equal(launched[2]!.exitCode, 0);
      } else {
        assert.equal(launched.length, 2);
        assert.equal(launched[0]!.exitCode, 0);
        assert.equal(launched[1]!.exitCode, 0);
      }
      assert.equal(supervisor.status().state, "stopped");
      assert.deepEqual(await new DataRootLock(layout.lockFile).inspect(), { state: "missing" });
      await assert.rejects(requestControl(layout.controlEndpoint, { command: "status" }));
      if (process.env.ZCODE_SUPERVISOR_UNCERTAIN_PROBE === "1") {
        // 中文：探针故意留下 execution-unknown 历史；它按产品语义永久 fencing 后续
        // 非 force 维护（新 boot 的 externalActivity.uncertain>0）。后续阶段需要的是
        // 干净 root——相当于运维人工核验后删除不可裁决的会话历史。这里在所有
        // Core 已停止、锁已释放的窗口执行该人工处置，不是绕过 fencing。
        await rm(
          join(layout.dataBaseDir, ".zcode", "v2", "workspace-hierarchy", "agent-host"),
          { recursive: true, force: true },
        );
      }
      // Test setup only: restore A while no owner/lock exists, preserving two independently
      // installed archives, so the next installed CLI executes its own production update.
      await releases.restoreCurrent(manifest);
      await releases.writePending(candidate);

      // 另起真正的已安装 CLI 入口，走 cli.ts 的生产 release/Node/Agent 选择逻辑，
      // 不是测试中重写一个看似等价的 launcher。
      const cli = spawn(
        runtimeNode,
        [
          join(runtime, "server-cli.js"),
          "serve",
          "--supervisor",
          "--server-root",
          layout.serverRoot,
        ],
        {
          cwd: dir,
          env: {
            ...isolatedEnv,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, "config"),
            ZCODE_DATA_BASE_DIR: dir,
            ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
            ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      const cliClosed = new Promise<void>((resolveClosed) =>
        cli.once("close", () => resolveClosed()),
      );
      let cliStderr = "";
      cli.stderr?.on("data", (chunk: Buffer) => {
        cliStderr += chunk.toString().replaceAll(dir, "<profile>");
      });
      let cliCorePid: number | undefined;
      try {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          if (cli.exitCode !== null || cli.signalCode !== null)
            throw new Error(`installed CLI exited before READY: ${cliStderr}`);
          try {
            const status = (await requestControl(
              layout.controlEndpoint,
              { command: "status" },
              1000,
            )) as {
              state: string;
              pid: number | null;
              generation: number;
            };
            if (status.state === "ready" && status.pid) {
              cliCorePid = status.pid;
              assert.equal(status.generation, 1);
              break;
            }
          } catch {
            // Socket 还未创建时重试；终态/READY 仍受绝对 deadline 约束。
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        }
        assert.ok(cliCorePid, `installed CLI/default launcher did not reach READY: ${cliStderr}`);
        await assert.rejects(
          requestControl(layout.controlEndpoint, { command: "apply-update" }),
          /Trusted local boot selection missing/,
          "no archive-provided boolean or inherited env may authorize held update",
        );
        assert.equal(
          ((await requestControl(layout.controlEndpoint, { command: "status" })) as { pid: number })
            .pid,
          cliCorePid,
        );
        assert.deepEqual(await releases.readCurrentForExecution(), manifest);
        assert.deepEqual(await releases.readPending(), candidate);
        const artifactSha256 = {
          "server-cli.js": sourceHashes[0]!,
          "server-core.js": sourceHashes[1]!,
          "piWorker.js": sourceHashes[2]!,
          "zcode.cjs": sourceHashes[3]!,
          node: sourceHashes[4]!,
        };
        for (const local of [manifest, candidate]) {
          await registerTrustedLocalSourceBootSelection(layout, local, {
            protocol: "constructor-held-native-v1",
            sourceRecipe:
              "LOCAL SOURCE ONLY: rebuilt bootstrap, Agent and Core; real held claim/wrong-token/exact-release in this fixture",
            artifactSha256,
            componentSha256: Object.fromEntries(
              (local.components ?? []).map((item) => [item.id, item.sha256]),
            ),
            releaseContentSha256: await hashReleaseTree(local.releaseDir),
          });
        }
        assert.deepEqual(
          await requestControl(layout.controlEndpoint, { command: "begin-fallback-migration" }),
          { ready: true },
        );
        assert.deepEqual(
          await requestControl(layout.controlEndpoint, { command: "end-fallback-migration" }),
          { released: true },
        );
        assert.deepEqual(
          await requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
          { applied: true, version: "local-source-b" },
        );
        const afterDefaultUpdate = (await requestControl(layout.controlEndpoint, {
          command: "status",
        })) as {
          state: string;
          generation: number;
          pid: number | null;
        };
        assert.equal(afterDefaultUpdate.state, "ready");
        assert.equal(afterDefaultUpdate.generation, 2);
        assert.notEqual(afterDefaultUpdate.pid, cliCorePid);
        assert.throws(() => process.kill(cliCorePid!, 0), { code: "ESRCH" });
        process.stdout.write(
          "installed default CLI two-archive held update: old Core reaped, generation2 ready after ACK\n",
        );
        cliCorePid = afterDefaultUpdate.pid ?? undefined;
        assert.deepEqual(await releases.readCurrentForExecution(), candidate);
        assert.equal(await releases.readPending(), null);
        assert.deepEqual(await requestControl(layout.controlEndpoint, { command: "stop" }), {
          stopping: true,
        });
        const closed = await Promise.race([
          cliClosed.then(() => true),
          new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 10_000)),
        ]);
        assert.equal(
          closed,
          true,
          `installed CLI failed to close: pid=${cli.pid} lock=${JSON.stringify(await new DataRootLock(layout.lockFile).inspect())} status=${(await readFile(layout.statusFile, "utf8").catch(() => "missing")).slice(0, 500)} stderr=${cliStderr}`,
        );
        assert.equal(cli.exitCode, 0, cliStderr);
        // 中文：不凭一个可能复用的 PID 杀进程；只读检验 CLI 的 Supervisor 已收口 Core。
        assert.throws(() => process.kill(cliCorePid!, 0), { code: "ESRCH" });
        assert.deepEqual(await new DataRootLock(layout.lockFile).inspect(), { state: "missing" });
        await assert.rejects(requestControl(layout.controlEndpoint, { command: "status" }));
      } finally {
        if (cli.exitCode === null && cli.signalCode === null) {
          await requestControl(layout.controlEndpoint, { command: "stop" }).catch(() => undefined);
          if (
            !(await Promise.race([
              cliClosed.then(() => true),
              new Promise<false>((resolveTimeout) =>
                setTimeout(() => resolveTimeout(false), 2_000),
              ),
            ]))
          )
            cli.kill("SIGTERM");
        }
        const finished = await Promise.race([
          cliClosed.then(() => true),
          new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
        ]);
        assert.equal(finished, true, "owned installed CLI must close before profile removal");
      }

      // Controlled launch-failure fault after trusted A/B preflight: the installed candidate
      // Core receives no compatible boot declaration, so its REAL factory fails before READY;
      // rollback must verify and boot the installed previous Core held, not a fake authority.
      await releases.writePending(manifest);
      const rollbackChildren: ChildProcess[] = [];
      const rollbackClosed: Promise<void>[] = [];
      const rollbackSupervisor = new Supervisor({
        layout,
        version: candidate.version,
        coreReadyTimeoutMs: 8_000,
        verifyHeldRelease: (release) => verifyTrustedLocalSourceBootSelection(layout, release),
        launcher: {
          launch(generation, release, bootMode, selected) {
            assert.ok(release?.releaseDir);
            const root = join(release.releaseDir, "runtime");
            const node = join(root, "node");
            const child = fork(join(root, "server-core.js"), [String(generation), bootMode], {
              execPath: node,
              execArgv: [],
              cwd: dir,
              env: {
                ...isolatedEnv,
                // 中文：Supervisor occupancy 恢复命名空间即 getAppConfigDir(layout.dataBaseDir)。
                ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
                ZCODE_SERVER_ROOT: layout.serverRoot,
                ...createReleaseAgentWiring(root, node, {}, selected),
                // Drop only the candidate declaration at this transport fault boundary;
                // previous release remains trusted and receives a genuine held lease.
                ZCODE_AGENT_SERVER_BOOT_FENCE_V1:
                  generation === 2 && bootMode === "held"
                    ? undefined
                    : selected?.protocol === "constructor-held-native-v1"
                      ? "1"
                      : undefined,
              },
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            });
            rollbackChildren.push(child);
            rollbackClosed.push(
              new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed())),
            );
            return child;
          },
        },
      });
      try {
        await rollbackSupervisor.start();
        const readyDeadline = Date.now() + 25_000;
        while (rollbackSupervisor.status().state !== "ready" && Date.now() < readyDeadline)
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        assert.equal(rollbackSupervisor.status().state, "ready");
        await assert.rejects(
          requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
          /Core failed|ready|boot/i,
        );
        assert.equal(
          rollbackSupervisor.status().state,
          "ready",
          "a positively acknowledged previous-release open returns rollback to ready",
        );
        assert.equal(rollbackSupervisor.status().generation, 3);
        assert.equal(rollbackSupervisor.status().pid, rollbackChildren[2]?.pid);
        assert.equal(rollbackChildren[0]?.exitCode, 0);
        assert.ok(
          rollbackChildren[1]?.exitCode !== null || rollbackChildren[1]?.signalCode !== null,
          "failed candidate must be reaped before previous held Core launches",
        );
        assert.deepEqual(await releases.readCurrentForExecution(), candidate);
        assert.equal(await releases.readPending(), null);
        assert.equal(
          await stat(layout.updateTransactionFile).then(
            () => true,
            () => false,
          ),
          false,
        );
        process.stdout.write(
          "real pre-open candidate failure: child2 reaped, previous installed B held rollback gen3 opened after restored pointer\n",
        );
      } finally {
        await rollbackSupervisor.stop("installed-rollback-cleanup");
        for (const [index, child] of rollbackChildren.entries()) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          const closed = await Promise.race([
            rollbackClosed[index]!.then(() => true),
            new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
          ]);
          if (!closed) child.kill("SIGKILL");
          assert.equal(
            await Promise.race([
              rollbackClosed[index]!.then(() => true),
              new Promise<false>((resolveTimeout) =>
                setTimeout(() => resolveTimeout(false), 2_000),
              ),
            ]),
            true,
            "rollback fixture child must close before profile removal",
          );
        }
      }
      assert.equal(rollbackChildren.length, 3);
      assert.equal(rollbackChildren[2]!.exitCode, 0);
      assert.deepEqual(await new DataRootLock(layout.lockFile).inspect(), { state: "missing" });
      await assert.rejects(requestControl(layout.controlEndpoint, { command: "status" }));

      // Transport-only loss AFTER an actual Core processed the exact boot-release request.
      // The real candidate may now admit native work; no rollback or automatic kill is safe.
      await releases.writePending(manifest);
      const ackChildren: ChildProcess[] = [];
      const ackClosed: Promise<void>[] = [];
      let droppedOpenAck: { requestId: string; leaseId: string } | undefined;
      const ackSupervisor = new Supervisor({
        layout,
        version: candidate.version,
        coreReadyTimeoutMs: 8_000,
        verifyHeldRelease: (release) => verifyTrustedLocalSourceBootSelection(layout, release),
        launcher: {
          launch(generation, release, bootMode, selected) {
            assert.ok(release?.releaseDir);
            const root = join(release.releaseDir, "runtime");
            const node = join(root, "node");
            const child = fork(join(root, "server-core.js"), [String(generation), bootMode], {
              execPath: node,
              execArgv: [],
              cwd: dir,
              env: {
                ...isolatedEnv,
                ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
                ZCODE_SERVER_ROOT: layout.serverRoot,
                ...createReleaseAgentWiring(root, node, {}, selected),
              },
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            });
            if (generation === 2 && bootMode === "held") {
              const originalEmit = (
                child.emit as (event: string, ...values: unknown[]) => boolean
              ).bind(child);
              child.emit = ((event: string, ...values: unknown[]) => {
                const value = values[0];
                if (
                  event === "message" &&
                  !droppedOpenAck &&
                  value &&
                  typeof value === "object" &&
                  "type" in value &&
                  value.type === "maintenance" &&
                  "requestId" in value &&
                  typeof value.requestId === "string" &&
                  "leaseId" in value &&
                  typeof value.leaseId === "string"
                ) {
                  droppedOpenAck = { requestId: value.requestId, leaseId: value.leaseId };
                  return false; // suppress only OS IPC delivery to Supervisor, never Core's effect
                }
                return originalEmit(event, ...values);
              }) as typeof child.emit;
            }
            ackChildren.push(child);
            ackClosed.push(
              new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed())),
            );
            return child;
          },
        },
      });
      try {
        await ackSupervisor.start();
        const readyDeadline = Date.now() + 25_000;
        while (ackSupervisor.status().state !== "ready" && Date.now() < readyDeadline)
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        assert.equal(ackSupervisor.status().state, "ready");
        await assert.rejects(
          requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
          /release|acknowledge|uncertain/i,
        );
        assert.ok(droppedOpenAck?.requestId && droppedOpenAck.leaseId);
        assert.match(droppedOpenAck.requestId, /^[a-f0-9-]{36}$/iu);
        assert.equal(ackSupervisor.status().state, "stop-failed");
        assert.equal(ackSupervisor.status().pid, ackChildren[1]?.pid);
        assert.equal(ackChildren[0]?.exitCode, 0);
        assert.equal(ackChildren[1]?.exitCode, null, "possibly admitting Core remains live");
        assert.deepEqual(await releases.readCurrentForExecution(), manifest);
        assert.equal(await releases.readPending(), null);
        assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");
        // Fresh real Core maintenance proves underlying boot release opened its native gate.
        const admitted = ackChildren[1]!;
        async function directMaintenance(
          command: "maintenance-begin" | "maintenance-release",
          leaseId?: string,
        ) {
          const requestId = randomUUID();
          const response = new Promise<Record<string, unknown>>((resolveReply, reject) => {
            const timer = setTimeout(
              () => reject(new Error("actual open-ACK-loss Core did not answer")),
              5_000,
            );
            function onMessage(message: Record<string, unknown>) {
              if (message.type !== "maintenance" || message.requestId !== requestId) return;
              clearTimeout(timer);
              admitted.off("message", onMessage);
              resolveReply(message);
            }
            admitted.on("message", onMessage);
          });
          admitted.send({ command, requestId, ...(leaseId ? { leaseId } : {}) });
          return await response;
        }
        const actualOpen = await directMaintenance("maintenance-begin");
        assert.ok(actualOpen.leaseId, "Core truly reopened despite missing Supervisor ACK");
        assert.deepEqual(actualOpen.nativeActivity, { running: 0, waiting: 0, uncertain: 0 });
        assert.equal(
          (await directMaintenance("maintenance-release", String(actualOpen.leaseId))).leaseId,
          actualOpen.leaseId,
        );
        assert.equal(ackSupervisor.status().state, "stop-failed");
        assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");
        process.stdout.write(
          "real Core post-open ACK lost: actual reply suppressed once, newly opened maintenance succeeds; previous B reaped, candidate A/pointer/lock retained stop-failed\n",
        );
      } finally {
        // Explicit operator-equivalent cleanup only after asserting uncertain owner retained.
        await ackSupervisor.stop("installed-open-ack-loss-fixture-cleanup");
        for (const [index, child] of ackChildren.entries()) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          const closed = await Promise.race([
            ackClosed[index]!.then(() => true),
            new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2_000)),
          ]);
          if (!closed) child.kill("SIGKILL");
          assert.equal(
            await Promise.race([
              ackClosed[index]!.then(() => true),
              new Promise<false>((resolveTimeout) =>
                setTimeout(() => resolveTimeout(false), 2_000),
              ),
            ]),
            true,
            "ACK-loss fixture child must close before profile removal",
          );
        }
      }
      assert.equal(ackChildren.length, 2);
      assert.equal(ackChildren[1]!.exitCode, 0);
      assert.deepEqual(await new DataRootLock(layout.lockFile).inspect(), { state: "missing" });
      await assert.rejects(requestControl(layout.controlEndpoint, { command: "status" }));

      // Rollback is a separate possible-open boundary: fail the candidate before READY,
      // then lose only the previous installed Core's real ACK after its release effect.
      await releases.restoreCurrent(candidate);
      await releases.writePending(manifest);
      const rollbackAckChildren: ChildProcess[] = [];
      const rollbackAckClosed: Promise<void>[] = [];
      let droppedRollbackOpenAck: { requestId: string; leaseId: string } | undefined;
      const rollbackAckSupervisor = new Supervisor({
        layout,
        version: candidate.version,
        coreReadyTimeoutMs: 8_000,
        verifyHeldRelease: (release) => verifyTrustedLocalSourceBootSelection(layout, release),
        launcher: {
          launch(generation, release, bootMode, selected) {
            assert.ok(release?.releaseDir);
            const root = join(release.releaseDir, "runtime");
            const node = join(root, "node");
            const child = fork(join(root, "server-core.js"), [String(generation), bootMode], {
              execPath: node,
              execArgv: [],
              cwd: dir,
              env: {
                ...isolatedEnv,
                ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
                ZCODE_SERVER_ROOT: layout.serverRoot,
                ...createReleaseAgentWiring(root, node, {}, selected),
                // Gen2 is the deliberately unsupported candidate and must fail before READY.
                ZCODE_AGENT_SERVER_BOOT_FENCE_V1:
                  generation === 2 && bootMode === "held"
                    ? undefined
                    : selected?.protocol === "constructor-held-native-v1"
                      ? "1"
                      : undefined,
              },
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            });
            if (generation === 3 && bootMode === "held") {
              const originalEmit = (
                child.emit as (event: string, ...values: unknown[]) => boolean
              ).bind(child);
              child.emit = ((event: string, ...values: unknown[]) => {
                const value = values[0];
                if (
                  event === "message" &&
                  !droppedRollbackOpenAck &&
                  value &&
                  typeof value === "object" &&
                  "type" in value &&
                  value.type === "maintenance" &&
                  "requestId" in value &&
                  typeof value.requestId === "string" &&
                  "leaseId" in value &&
                  typeof value.leaseId === "string"
                ) {
                  droppedRollbackOpenAck = {
                    requestId: value.requestId,
                    leaseId: value.leaseId,
                  };
                  return false; // suppress delivery only; the real previous Core already opened.
                }
                return originalEmit(event, ...values);
              }) as typeof child.emit;
            }
            rollbackAckChildren.push(child);
            rollbackAckClosed.push(
              new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed())),
            );
            return child;
          },
        },
      });
      try {
        await rollbackAckSupervisor.start();
        const readyDeadline = Date.now() + 25_000;
        while (rollbackAckSupervisor.status().state !== "ready" && Date.now() < readyDeadline)
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
        assert.equal(rollbackAckSupervisor.status().state, "ready");
        await assert.rejects(
          requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
          /release|acknowledge|uncertain/i,
        );
        assert.ok(
          droppedRollbackOpenAck?.requestId && droppedRollbackOpenAck.leaseId,
          "the previous installed Core's actual release ACK must be suppressed after effect",
        );
        assert.match(droppedRollbackOpenAck.requestId, /^[a-f0-9-]{36}$/iu);
        assert.equal(rollbackAckSupervisor.status().state, "stop-failed");
        assert.equal(rollbackAckSupervisor.status().generation, 3);
        assert.equal(rollbackAckSupervisor.status().pid, rollbackAckChildren[2]?.pid);
        assert.equal(rollbackAckChildren.length, 3);
        assert.equal(rollbackAckChildren[0]?.exitCode, 0, "old current Core was reaped");
        assert.equal(
          rollbackAckChildren[1]?.exitCode,
          1,
          "candidate lacking the constructor-held fence must fail before READY",
        );
        assert.equal(rollbackAckChildren[2]?.exitCode, null, "possibly-open rollback remains live");
        assert.deepEqual(await releases.readCurrentForExecution(), candidate);
        assert.equal(await releases.readPending(), null);
        assert.equal(
          await stat(layout.updateTransactionFile).then(
            () => true,
            () => false,
          ),
          false,
          "the pointer restore transaction must be closed before rollback open",
        );
        assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");

        // This fresh maintenance roundtrip proves the suppressed release changed actual
        // admission state on this same rollback Core, not a fixture-side held flag.
        const rollbackCore = rollbackAckChildren[2]!;
        async function rollbackMaintenance(
          command: "maintenance-begin" | "maintenance-release",
          leaseId?: string,
        ) {
          const requestId = randomUUID();
          const response = new Promise<Record<string, unknown>>((resolveReply, reject) => {
            const timer = setTimeout(
              () => reject(new Error("actual rollback Core did not answer maintenance")),
              5_000,
            );
            function onMessage(message: Record<string, unknown>) {
              if (message.type !== "maintenance" || message.requestId !== requestId) return;
              clearTimeout(timer);
              rollbackCore.off("message", onMessage);
              resolveReply(message);
            }
            rollbackCore.on("message", onMessage);
          });
          rollbackCore.send({ command, requestId, ...(leaseId ? { leaseId } : {}) });
          return await response;
        }
        const actualRollbackOpen = await rollbackMaintenance("maintenance-begin");
        assert.ok(actualRollbackOpen.leaseId, "rollback Core really opened after the lost ACK");
        assert.deepEqual(actualRollbackOpen.nativeActivity, {
          running: 0,
          waiting: 0,
          uncertain: 0,
        });
        assert.deepEqual(actualRollbackOpen.externalActivity, {
          running: 0,
          waiting: 0,
          uncertain: 0,
        });
        assert.equal(
          (await rollbackMaintenance("maintenance-release", String(actualRollbackOpen.leaseId)))
            .leaseId,
          actualRollbackOpen.leaseId,
        );
        assert.equal(rollbackAckSupervisor.status().state, "stop-failed");
        assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");

        // Retry remains blocked on the uncertain lifecycle owner and cannot launch a third
        // replacement, even if a new pending archive appears.
        await releases.writePending(manifest);
        await assert.rejects(
          requestControl(layout.controlEndpoint, { command: "apply-update" }, 30_000),
          /maintenance|Core unavailable/i,
        );
        assert.equal(rollbackAckChildren.length, 3);
        assert.equal(rollbackAckSupervisor.status().pid, rollbackAckChildren[2]?.pid);
        assert.deepEqual(await releases.readCurrentForExecution(), candidate);
        assert.deepEqual(await releases.readPending(), manifest);
        assert.equal((await new DataRootLock(layout.lockFile).inspect()).state, "active");
        process.stdout.write(
          "real rollback open ACK lost: candidate reaped; previous Core effect opened, matching ACK suppressed; previous pointer/live owner/lock retained stop-failed; retry launched no third Core\n",
        );
      } finally {
        // Explicit fixture cleanup follows the uncertainty assertions; never auto-recover by PID.
        try {
          await rollbackAckSupervisor.stop("installed-rollback-open-ack-loss-fixture-cleanup");
        } finally {
          for (const [index, child] of rollbackAckChildren.entries()) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            let closed = await Promise.race([
              rollbackAckClosed[index]!.then(() => true),
              new Promise<false>((resolveTimeout) =>
                setTimeout(() => resolveTimeout(false), 2_000),
              ),
            ]);
            if (!closed) {
              child.kill("SIGKILL");
              closed = await Promise.race([
                rollbackAckClosed[index]!.then(() => true),
                new Promise<false>((resolveTimeout) =>
                  setTimeout(() => resolveTimeout(false), 2_000),
                ),
              ]);
            }
            assert.equal(closed, true, "owned rollback Core must close before profile removal");
          }
          await releases.removePending();
        }
      }
      assert.equal(rollbackAckChildren.length, 3);
      assert.equal(rollbackAckChildren[2]!.exitCode, 0);
      assert.deepEqual(await new DataRootLock(layout.lockFile).inspect(), { state: "missing" });
      await assert.rejects(requestControl(layout.controlEndpoint, { command: "status" }));
      assert.equal(
        await access(poisonMarker).then(
          () => true,
          () => false,
        ),
        false,
      );
      assert.equal(
        await access(pathMarker).then(
          () => true,
          () => false,
        ),
        false,
      );
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
      if (fixtureModel) await fixtureModel.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  },
);
