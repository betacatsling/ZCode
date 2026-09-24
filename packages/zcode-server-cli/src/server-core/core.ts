import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/services/node";
import { IAgentHostService, IZCodeAgentService } from "@zcode/services";
import { coreCommandSchema, type RuntimeActivity } from "../contracts.js";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { createTaskActivityTracker, readExternalActivity } from "./taskActivityTracker.js";
import {
  CoreMaintenanceAdmission,
  type CoreMaintenanceAdmissionPort,
} from "./maintenanceAdmission.js";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(
  generation: number,
  maintenancePort?: CoreMaintenanceAdmissionPort,
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
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    serviceAuthorityMode: "standalone-server",
    agentHostTargetId: serverId,
  });
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(IZCodeAgentService));
  // Missing composition port blocks automatic maintenance; never infer safe idle from a heartbeat.
  const maintenance = new CoreMaintenanceAdmission(maintenancePort);
  // V2 Host 由集成层挂载；旧 Host 若无法报告外部活动必须视为不确定，不能假定空闲。
  const host = services.getOptional(IAgentHostService) as
    | (IAgentHostService & { getRuntimeActivity?: () => Promise<RuntimeActivity> })
    | undefined;
  const externalActivity = (): Promise<RuntimeActivity> => readExternalActivity(host);
  const http = await createCoreHttpServer(services, { serverId });
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
  });
  let shutdownStarted = false;
  let lastRunningTaskCount = taskActivityTracker.readRunningTaskCount();
  const activitySubscription = taskActivityTracker.onDidChangeRunningTaskCount(
    (runningTaskCount) => {
      lastRunningTaskCount = runningTaskCount;
      void externalActivity().then((activity) =>
        send({ type: "task-activity", runningTaskCount, externalActivity: activity }),
      );
    },
  );
  let heartbeatInFlight: Promise<void> | undefined;
  const reportHeartbeat = (): void => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = Promise.all([
      Promise.resolve(taskActivityTracker.readRunningTaskCount()),
      externalActivity(),
    ])
      .then(([runningTaskCount, activity]) => {
        if (runningTaskCount !== lastRunningTaskCount) {
          lastRunningTaskCount = runningTaskCount;
          void send({ type: "task-activity", runningTaskCount, externalActivity: activity });
        }
        void send({
          type: "heartbeat",
          at: Date.now(),
          runningTaskCount,
          externalActivity: activity,
        });
      })
      .catch(() => {
        void send({
          type: "heartbeat",
          at: Date.now(),
          runningTaskCount: lastRunningTaskCount,
          externalActivity: { running: 0, waiting: 0, uncertain: 1 },
        });
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
  };
  reportHeartbeat();
  const heartbeat = setInterval(reportHeartbeat, 10_000);
  shutdown = async (reason: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    disposeParentDisconnectHandler();
    clearInterval(heartbeat);
    activitySubscription.dispose();
    taskActivityTracker.dispose();
    await http.close().catch(() => undefined);
    await disposeServiceResourcesAndWait(services).catch(() => undefined);
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
  process.on("message", (raw: unknown) => {
    const parsed = coreCommandSchema.safeParse(raw);
    if (!parsed.success) return;
    const command = parsed.data;
    if (command.command === "shutdown") {
      void shutdown("requested");
    } else if (!shutdownStarted && command.command === "maintenance-begin") {
      void maintenance.begin().then(
        (activity) => send({ type: "maintenance", requestId: command.requestId, ...activity }),
        () => send({ type: "maintenance", requestId: command.requestId }),
      );
    } else if (!shutdownStarted && command.command === "maintenance-release") {
      void maintenance.release(command.leaseId).then(
        () => send({ type: "maintenance", requestId: command.requestId, leaseId: command.leaseId }),
        () => send({ type: "maintenance", requestId: command.requestId }),
      );
    } else if (!shutdownStarted && command.command === "activity") {
      void externalActivity().then((activity) =>
        send({
          type: "activity",
          requestId: command.requestId,
          runningTaskCount: taskActivityTracker.readRunningTaskCount(),
          externalActivity: activity,
        }),
      );
    }
  });
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
