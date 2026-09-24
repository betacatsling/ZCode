import {
  materializeZCodeBuiltinProviderConfig,
  getAppConfigDir,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  createServiceLogger,
} from "@zcode/services/node";
import { IAgentHostService, IZCodeAgentService } from "@zcode/services";
import { coreCommandSchema, type RuntimeActivity } from "../contracts.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { createProductionCoreAuthority, type CoreAuthorityFactory } from "./authority.js";
import { ZCODE_VERSION } from "@zcode/shared";
import { createCoreHttpServer } from "./http.js";
import { installParentDisconnectHandler } from "./parentDisconnect.js";
import { resolveCoreServerId } from "./serverIdentity.js";
import { maintenanceBeginReply } from "./maintenanceReply.js";
import { createTaskActivityTracker, readExternalActivity } from "./taskActivityTracker.js";
import { CoreMaintenanceAdmission } from "./maintenanceAdmission.js";

const log = createServiceLogger("server-core");

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export async function runServerCore(
  generation: number,
  createAuthority: CoreAuthorityFactory = createProductionCoreAuthority,
  bootHeld = false,
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
  if (!serverId) throw new Error("Persistent Core requires validated installation identity");
  const authority = await createAuthority({
    installationId: serverId,
    profileRoot: resolveServerLayout(process.env.ZCODE_SERVER_ROOT).serverRoot,
    zcodeBuiltinProviderConfigFilePath,
    admissionFence: bootHeld ? "held" : "open",
  });
  if (
    !authority.services ||
    !authority.maintenance?.freezeAdmissions ||
    !authority.maintenance.readActivity ||
    !authority.reconcileBeforeAdmission ||
    !authority.dispose
  ) {
    await authority.dispose?.();
    throw new Error("Persistent Core authority is missing required lifecycle or maintenance ports");
  }
  const services = authority.services;
  const maintenance = new CoreMaintenanceAdmission(authority.maintenance);
  let bootLeaseId: string | undefined;
  // 中文：候选 Core 的原生/Host 写入必须在 factory 构造期间已关闭；
  // IPC 在这里仅收养工厂原始租约，不能再次 freeze（会死锁，也无法弥补构造期空窗）。
  try {
    if (bootHeld) {
      if (!authority.bootAdmissionLease)
        throw new Error("Core authority did not establish pre-initialization boot admission hold");
      bootLeaseId = maintenance.adoptBootLease(authority.bootAdmissionLease);
    }
    // 失败只影响普通启动的新 admission；事务候选必须拒绝提交，否则恢复后可能接收写入。
    await authority.reconcileBeforeAdmission();
  } catch (error) {
    if (bootHeld) {
      disposeParentDisconnectHandler();
      await maintenance.releaseHeld().catch(() => undefined);
      await authority.dispose();
      throw error;
    }
    log.warn("Core authority reconciliation incomplete; new admission remains closed", error);
  }
  const taskActivityTracker = createTaskActivityTracker(services.getOptional(IZCodeAgentService));
  // V2 Host 由集成层挂载；旧 Host 若无法报告外部活动必须视为不确定，不能假定空闲。
  const host = services.getOptional(IAgentHostService) as
    | (IAgentHostService & { getRuntimeActivity?: () => Promise<RuntimeActivity> })
    | undefined;
  const externalActivity = (): Promise<RuntimeActivity> => readExternalActivity(host);
  let http: Awaited<ReturnType<typeof createCoreHttpServer>>;
  try {
    http = await createCoreHttpServer(services, { serverId });
  } catch (error) {
    // 中文：装配成功但 HTTP 绑定失败时不能留存单例 Catalog/Host 写入者。
    taskActivityTracker.dispose();
    disposeParentDisconnectHandler();
    await maintenance.releaseHeld().catch(() => undefined);
    await authority
      .dispose()
      .catch((disposeError: unknown) =>
        log.error("failed to dispose authority after Core boot failure", disposeError),
      );
    throw error;
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
    ...(bootLeaseId ? { bootLeaseId } : {}),
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
    // 中文：进程关闭时仅释放本代际持有的 admission lease；窗口断连不会触发此路径。
    await maintenance
      .releaseHeld()
      .catch((error: unknown) =>
        log.error("failed to release Core maintenance lease on shutdown", error),
      );
    await authority
      .dispose()
      .catch((error: unknown) => log.error("failed to dispose Core authority on shutdown", error));
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
        // 中文：内部 owner 返回 native/external，而 IPC 合同要求 nativeActivity/externalActivity；
        // 直接展开会丢掉活动字段，Supervisor 把已冻结的 Core 误判为无确认。
        (activity) => send(maintenanceBeginReply(command.requestId, activity)),
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
