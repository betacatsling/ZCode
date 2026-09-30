import {
  createLocalServices,
  createServiceLogger,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  getConversationWorkspaceDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/services/node";
import { IAgentHostService, IZCodeAgentService } from "@zcode/services";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { createHostBootstrapToken } from "./hostBootstrapAuth.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker } from "./taskActivityTracker.js";
import type { ExternalTaskActivitySource } from "./taskActivityTracker.js";
import { mkdir } from "node:fs/promises";
import {
  removeCoreHostBootstrapFile,
  writeCoreHostBootstrapFile,
} from "../runtime/coreHostBootstrap.js";
import { resolveServerLayout } from "../runtime/paths.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

type CoreServices = ReturnType<typeof createLocalServices>;

const log = createServiceLogger("server-core");

/** Internal lifecycle ports for packaged and embedded Server Core runners. */
export interface ServerCoreRuntimePorts {
  createServices?: (options: Parameters<typeof createLocalServices>[0]) => CoreServices;
  disposeServices?: (services: CoreServices) => Promise<void>;
}

export async function loadExternalTaskActivity(
  agentHost: Pick<IAgentHostService, "listActivityIndex">,
) {
  return await agentHost.listActivityIndex();
}

export async function runServerCore(
  generation: number,
  ports: ServerCoreRuntimePorts = {},
): Promise<void> {
  let shutdown: ((reason: string) => Promise<void>) | undefined;
  let parentDisconnected = false;
  let disposeParentDisconnectHandler = (): void => undefined;
  disposeParentDisconnectHandler = installParentDisconnectHandler(() => {
    if (shutdown) void shutdown("parent-disconnected");
    else parentDisconnected = true;
  });
  const explicitZCodeBuiltinProviderConfigFilePath =
    process.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const zcodeBuiltinProviderConfigFilePath = explicitZCodeBuiltinProviderConfigFilePath
    ? explicitZCodeBuiltinProviderConfigFilePath
    : typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ === "string"
      ? await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__,
        })
      : undefined;
  if (!zcodeBuiltinProviderConfigFilePath) {
    throw new Error(
      `当前构建未嵌入 ZCode Built-in Provider Config，且未设置 ${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV}`,
    );
  }
  const serverId = await resolveCoreServerId();
  const spawnFallbackCwd = getConversationWorkspaceDir();
  await mkdir(spawnFallbackCwd, { recursive: true, mode: 0o700 });
  const services = (ports.createServices ?? createLocalServices)({
    zcodeBuiltinProviderConfigFilePath,
    serviceAuthorityMode: "standalone-server",
    agentHostTargetId: serverId,
    agentHostOwnerGeneration: generation,
    // 缺失 cwd 的只读 session/history 查询可使用该稳定目录；写入入口会在 getClient 再验证原路径。
    zcodeAgentSpawnFallbackCwd: spawnFallbackCwd,
    // Target credential provisioning is available only through the protected desktop Host channel.
    providerProvisioningTargetEnabled: true,
  });
  const agentHost = services.getOptional(IAgentHostService);
  const externalActivity: ExternalTaskActivitySource | undefined = agentHost
    ? {
        onEvent: agentHost.onEvent,
        readIndex: () => loadExternalTaskActivity(agentHost),
      }
    : undefined;
  const taskActivityTracker = createTaskActivityTracker(
    services.getOptional(IZCodeAgentService),
    externalActivity,
  );
  await taskActivityTracker.whenReady();
  // 每次 Core 启动生成新的 Host bootstrap secret，只经 fork IPC 交给 Supervisor；不进入 env，
  // 避免被 Core 派生的 Agent/工具进程继承。
  const hostBootstrapToken = createHostBootstrapToken();
  const http = await createCoreHttpServer(services, { serverId, hostBootstrapToken });
  // 版本错配兜底：pre-M2 Supervisor 的 ready schema 会丢弃 hostBootstrapToken，Core 另写 0600
  // run/core-host-bootstrap.json，由新 CLI 在 status 缺 secret 且 generation/pid/port 匹配时合并。
  // 必须在 ready 之前落盘，CLI 一旦看到 ready 就能读到本代记录；写失败不影响新 Supervisor 路径。
  const serverRoot = process.env.ZCODE_SERVER_ROOT?.trim();
  const bootstrapFileLayout = serverRoot ? resolveServerLayout(serverRoot) : undefined;
  const bootstrapFileOwner = { generation, pid: process.pid };
  if (bootstrapFileLayout) {
    await writeCoreHostBootstrapFile(bootstrapFileLayout, {
      ...bootstrapFileOwner,
      host: http.host,
      port: http.port,
      hostBootstrapToken: http.hostBootstrapToken,
    }).catch((error: unknown) => {
      log.warn("failed to write Core Host bootstrap file", error);
    });
  }
  const send = (message: unknown): Promise<void> => {
    if (typeof process.send !== "function" || process.connected === false) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        process.send?.(message, () => resolve());
      } catch {
        // 父进程断连后的最后一条生命周期消息不应阻塞资源释放。
        resolve();
      }
    });
  };
  // ready.version 的语义是 Core 版本；不能误发 Node runtime 版本常量
  // （22.16.0），否则消费方读取会拿到错误值。
  await send({
    type: "ready",
    host: http.host,
    port: http.port,
    version: ZCODE_VERSION,
    generation,
    hostBootstrapToken: http.hostBootstrapToken,
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void send({ type: "task-activity", runningTaskCount });
    },
  );
  if (lastRunningTaskCount > 0) {
    // 修复依据：重启 Core 时初始索引可能含 execution-unknown；ready 后立即发布，不能等心跳窗口让更新门暂时报 idle。
    await send({ type: "task-activity", runningTaskCount: lastRunningTaskCount });
  }
  let heartbeatInFlight: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve(taskActivityTracker.readRunningTaskCount())
      .then((runningTaskCount) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({ type: "task-activity", runningTaskCount });
        }
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount });
      })
      .catch(() => {
        void send({ type: "heartbeat", at: Date.now(), runningTaskCount: lastRunningTaskCount });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  }, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    await http.close().catch(() => undefined);
    if (bootstrapFileLayout) {
      await removeCoreHostBootstrapFile(bootstrapFileLayout, bootstrapFileOwner).catch(
        () => undefined,
      );
    }
    await (ports.disposeServices ?? disposeServiceResourcesAndWait)(services).catch(
      () => undefined,
    );
    await send({ type: "shutdown-ack" });
    await send({ type: "exit", reason });
    try {
      process.disconnect?.();
    } catch {
      // 父进程已断连时 disconnect 可能报告 IPC_CHANNEL_CLOSED；不影响资源已释放后的退出。
    }
    // 仅设置 exitCode 无法关闭 Agent/SQLite 等仍持有的事件循环；Supervisor 的有界停止
    // 会因此等待到超时。资源释放完成后显式退出，确保 stop/restart/uninstall 真正收口。
    process.exit(0);
  };
  if (parentDisconnected) void shutdown("parent-disconnected");
  process.on("message", (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "command" in message &&
      message.command === "shutdown"
    ) {
      void shutdown("requested");
    }
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
