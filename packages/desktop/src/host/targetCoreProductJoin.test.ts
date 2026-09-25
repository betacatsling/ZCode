import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ZCODE_VERSION } from "@zcode/shared";
import {
  ChannelClient,
  Emitter,
  ProxyChannel,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import WebSocket from "ws";
import {
  IAgentHostService,
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
} from "@zcode/services";
import { mountLocalCore } from "./targetCoreMount.js";
import { createRemoteHierarchyAttachment } from "./remoteHierarchyAttachment.js";
import { registerPairedPhoneChannel } from "./pairedPhoneAgentHost.js";
import type { IServerChannel } from "@zcode/rpc";

/** Isolated real Core → one-use ticket → public RPC → window service collection. No authority fixture. */
test("real Core RPC mounts Git Catalog and hierarchy across window detach/restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "product-join-"));
  const repo = join(dir, "repo");
  const install = join(dir, "install");
  const config = join(dir, "builtin.json");
  await mkdir(repo);
  await writeFile(
    config,
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
  const git = promisify(execFile);
  await git("git", ["init", "-q", repo]);
  await git("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  const fixture = fileURLToPath(
    new URL(
      "../../../zcode-server-cli/src/server-core/coreProductionFactoryChild.fixture.ts",
      import.meta.url,
    ),
  );
  const children: ReturnType<typeof fork>[] = [];
  async function boot() {
    const child = fork(fixture, [], {
      execArgv: ["--import", import.meta.resolve("tsx")],
      env: {
        ...process.env,
        HOME: dir,
        ZCODE_DATA_BASE_DIR: dir,
        ZCODE_SERVER_ROOT: install,
        ZCODE_FIXTURE_INSTALL_ROOT: install,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (buffer: Buffer) => {
      stderr += buffer.toString();
    });
    const ready = await new Promise<{ host: string; port: number }>((resolve, reject) => {
      const deadline = setTimeout(() => {
        cleanup();
        reject(new Error(`Core boot deadline: ${stderr}`));
      }, 15_000);
      function message(value: unknown) {
        if (
          value &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "ready" &&
          "host" in value &&
          typeof value.host === "string" &&
          "port" in value &&
          typeof value.port === "number"
        ) {
          cleanup();
          resolve({ host: value.host, port: value.port });
        }
      }
      function exit(code: number | null) {
        cleanup();
        reject(new Error(`Core exited ${code}: ${stderr}`));
      }
      function cleanup() {
        clearTimeout(deadline);
        child.off("message", message);
        child.off("exit", exit);
      }
      child.on("message", message);
      child.once("exit", exit);
    });
    const ownership = JSON.parse(await readFile(join(install, "install.json"), "utf8")) as {
      installationId: string;
    };
    return {
      child,
      endpoint: `http://${ready.host}:${ready.port}`,
      installationId: ownership.installationId,
    };
  }
  try {
    const first = await boot();
    // Generic loopback WebSocket has no host capability: it must not expose real
    // Catalog, hierarchy or Host channels even though the same Core owns them.
    const ws = new WebSocket(first.endpoint.replace("http:", "ws:") + "/ws");
    const data = new Emitter<VSBuffer>();
    const close = new Emitter<void>();
    ws.on("message", (raw) => data.fire(VSBuffer.wrap(Buffer.from(raw as Buffer))));
    ws.on("close", () => close.fire());
    const socket: ISocket = {
      onData: data.event,
      onClose: close.event,
      onEnd: close.event,
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
      },
    };
    const protocol = new SocketProtocol(socket);
    const client = new ChannelClient(protocol);
    try {
      await once(ws, "open");
      const unauthorizedCatalog = ProxyChannel.toService(
        client.getChannel(IProjectCatalogRpcService.channelName),
      ) as { sidebarSnapshot(): Promise<unknown> };
      const unauthorizedHierarchy = ProxyChannel.toService(
        client.getChannel(IWorkspaceHierarchyService.channelName),
      ) as { listCreateOptions(id: string): Promise<unknown> };
      const unauthorizedHost = ProxyChannel.toService(
        client.getChannel(IAgentHostService.channelName),
      ) as { getAvailability(): Promise<unknown> };
      await assert.rejects(unauthorizedCatalog.sidebarSnapshot());
      await assert.rejects(unauthorizedHierarchy.listCreateOptions("main"));
      await assert.rejects(unauthorizedHost.getAvailability());
    } finally {
      client.dispose();
      protocol.dispose();
      ws.close();
      data.dispose();
      close.dispose();
    }
    const location = {
      endpoint: first.endpoint,
      installationId: first.installationId,
      version: ZCODE_VERSION,
      generation: 1,
    };
    const mount = await mountLocalCore(location);
    try {
      const catalog = mount.services.get(IProjectCatalogRpcService);
      const hierarchy = mount.services.get(IWorkspaceHierarchyService);
      await catalog.importProject({
        id: "project",
        bindingId: "binding",
        targetId: first.installationId,
        name: "Fixture Git",
        repositoryPath: repo,
      });
      const workspace = await catalog.adopt({
        bindingId: "binding",
        workspaceId: "main",
        title: "Main checkout",
        worktreePath: repo,
      });
      assert.equal((await catalog.sidebarSnapshot()).workspaces[0]?.id, "main");
      assert.equal(
        (
          await hierarchy.resolveWorkspace({
            targetId: first.installationId,
            workspacePath: workspace.worktreePath,
            workspaceIdentity: workspace.workspaceIdentity,
          })
        )?.workspaceId,
        "main",
      );
      assert.equal((await hierarchy.listCreateOptions("main")).workspaceId, "main");
      // 中文：旧路由只校验 createAgent 的返回 owner，错误 workspace 已经执行完；
      // 这里用两个实际 Core Catalog worktree 证明拒绝发生在 allocation 之前。
      const foreignPath = join(dir, "foreign-worktree");
      await git("git", ["-C", repo, "worktree", "add", "-qb", "foreign", foreignPath]);
      const foreign = await catalog.adopt({
        bindingId: "binding",
        workspaceId: "foreign",
        title: "Foreign checkout",
        worktreePath: foreignPath,
      });
      const scoped = createRemoteHierarchyAttachment(
        hierarchy,
        {
          kind: "remote",
          remoteSessionId: "isolated-regression-view",
          workspacePath: workspace.worktreePath,
          workspaceIdentity: workspace.workspaceIdentity,
        },
        async (action) => ({ status: "committed", value: await action(mount.services, () => {}) }),
      );
      const creation = {
        workspaceId: foreign.id,
        harnessId: "pi",
        modelBinding: {
          kind: "host-managed" as const,
          selection: { providerId: "fixture", modelId: "fixture" },
        },
        commandId: "foreign-worktree-must-never-allocate",
      } as Parameters<typeof scoped.createAgent>[0];
      await assert.rejects(scoped.createAgent(creation), /Remote target scope denied/);
      assert.equal(
        (await mount.services.get(IAgentHostService).listWorkspaceSessions(foreign.id)).length,
        0,
      );
      assert.equal(
        await mount.services.get(IAgentHostService).queryCreationCommand(creation.commandId),
        undefined,
      );
      assert.equal(
        (await mount.services.get(IAgentHostService).getAvailability()).target.id,
        first.installationId,
      );
      // 中文：真实 Core 两个 Git worktree 下，手机 Host RPC 也必须在 dispatch 之前
      // 复核 Catalog 与现存 session；不可因目标相同就把 foreign workspace ID 放行。
      const channels = new Map<string, IServerChannel>();
      registerPairedPhoneChannel(
        {
          registerChannel: (name, channel) => {
            channels.set(name, channel);
          },
        },
        mount.services,
        {
          workspaceId: workspace.id,
          hostSessionId: "selected-existing-session",
          workspacePath: workspace.worktreePath,
          workspaceIdentity: workspace.workspaceIdentity,
        },
        () => true,
      );
      assert.deepEqual(
        [...channels.keys()],
        [IAgentHostService.channelName, IWorkspaceHierarchyService.channelName],
      );
      const phoneHost = channels.get(IAgentHostService.channelName)!;
      await assert.rejects(
        phoneHost.call(null as never, "getSessionSpec", [
          {
            targetId: first.installationId,
            workspaceId: foreign.id,
            hostSessionId: "selected-existing-session",
          },
        ]),
        /denied/,
      );
      await assert.rejects(
        phoneHost.call(null as never, "dispatch", [
          {
            schemaVersion: 2,
            hostSessionId: "foreign-session",
            projectId: "project",
            workspaceId: foreign.id,
            execution: {
              targetId: first.installationId,
              worktreePath: foreign.worktreePath,
              workspaceIdentity: foreign.workspaceIdentity,
              worktreeGeneration: "1",
              cwdRelativeToWorktree: ".",
            },
            harness: { id: "pi", adapterVersion: "1" },
            modelBinding: { kind: "harness-managed" },
          },
          { type: "sendText" },
        ]),
        /denied/,
      );
      assert.equal(
        (await mount.services.get(IAgentHostService).listWorkspaceSessions(foreign.id)).length,
        0,
      );
      assert.equal(
        await mount.services
          .get(IAgentHostService)
          .queryCreationCommand("foreign-worktree-must-never-allocate"),
        undefined,
      );
    } finally {
      mount.attachment.dispose();
    }
    assert.equal(first.child.exitCode, null);
    const stop = once(first.child, "close");
    first.child.send({ command: "shutdown" });
    await stop;
    assert.equal(first.child.exitCode, 0);
    const resumed = await boot();
    const restored = await mountLocalCore({ ...location, endpoint: resumed.endpoint });
    try {
      assert.equal(
        (await restored.services.get(IProjectCatalogRpcService).sidebarSnapshot()).workspaces[0]
          ?.id,
        "main",
      );
    } finally {
      restored.attachment.dispose();
    }
    const end = once(resumed.child, "close");
    resumed.child.send({ command: "shutdown" });
    await end;
    assert.equal(resumed.child.exitCode, 0);
  } finally {
    for (const child of children) {
      if (child.exitCode !== null) continue;
      const exited = once(child, "close");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
