import { createHash } from "node:crypto";
import { createConfig } from "@zcode/adapters/config";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import { createNodeModelSelectionFacade } from "@zcode/provider-node";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createMcpAdapterConnectionPool,
  createMcpTelemetryTracker,
  type McpConnectionPool,
  type McpTelemetryTracker,
} from "@zcode/adapters/mcp";
import {
  zcodeProtocolNotifications,
  type ZCodeMcpResourceSample,
  type ZCodeMcpTelemetryEvent,
} from "@zcode/shared";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  traceContextToLogContext,
  createRootTraceContext,
  type LoggerFactory,
} from "@zcode/contracts";
import type { McpPort, ModelSelection, FileSystemPort, ExecutionPort, HttpClientPort } from "@zcode/contracts";
import type { PresentationSurface } from "@zcode/core";
import type { RunZCodeProtocolAgentOptions, ZCodeAppOptions } from "./app/types.js";
import { createZCodeApp } from "./app/create-app.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./zcode-protocol/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installZCodeProtocolAiSdkWarningLogger } from "./zcode-protocol/ai-sdk-warning-logger.js";
import {
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "./zcode-protocol/official-mcp-auth-port.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "./zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "./zcode-protocol/transport.js";
import { cleanupProtocolRuntime } from "./zcode-protocol/runtime-cleanup.js";
import { startProtocolResourceSampler } from "./zcode-protocol/resource-sampler.js";
import { acquireProtocolStartupResource } from "./zcode-protocol/startup-resource.js";
import type { ZCodeProcessResourceSampler } from "./process-resource-sampler.js";
import { prepareZCodeTelemetryEnv, shutdownZCodeTelemetry } from "./telemetry-bootstrap.js";

function applyProtocolPresentationSurface(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<ZCodeAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/** Registry 是当前 Environment 的模型事实源；旧 workspace snapshot 不参与执行。 */
function applyProtocolProviderRegistry(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  providerRegistry: ZCodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): ZCodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

/** Trusted in-process Node composition only; never serialized across V4 or account overlay. */
type ProcessRegistryRuntime = Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>;
type NativeProtocolRegistryRuntime = Pick<
  ProcessRegistryRuntime,
  "configuredDefaultModelSelection" | "syncAccountProviderConfig" | "snapshot" | "dispose"
> & { readonly runtime: Pick<ProcessRegistryRuntime["runtime"], "registryService"> };

export interface NativeProtocolBootstrapDependencies {
  /** 可信 Node-only 私有运行器可注入原有 Adapter 的观测配置；绝不进入 wire/schema。 */
  readonly modelAdapter?: AiSdkModelAdapter;
  /** 私有一次性验证不允许把 provider 原始错误/endpoint 落盘。 */
  readonly loggerFactory?: LoggerFactory;
  /** 私有 fixture 对免确认 Read 与底层 Bash 仍必须实施 I/O 端口级范围约束。 */
  readonly fileSystemPort?: FileSystemPort;
  readonly executionPort?: ExecutionPort;
  /** Native private validation: reject even preapproved WebFetch before network IO. */
  readonly httpClientPort?: HttpClientPort;
  /** Trusted disposable native run only: constrain registered tools before any handler executes. */
  readonly privateToolAllowlist?: readonly string[];
  /** Trusted Node-only private observation of native TurnStarted (not a wire/session projection). */
  readonly privateNativeTurnObservation?: (fact: {
    sessionId: string; runtimeTurnId: string; sourceCommandId: string; productMessageId: string;
  }) => void;
  /** Trusted native permission.requested fact; emitted before the broker, never a Model/RPC claim. */
  readonly privateNativePermissionObservation?: (fact: {
    sessionId: string; runtimeTurnId: string; requestId: string;
    toolCallId: string; toolName: string; inputDigest: string;
  }) => void;
  readonly startProviderRegistryRuntime?: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<NativeProtocolRegistryRuntime>;
}

export async function runZCodeProtocolAgent(
  options: RunZCodeProtocolAgentOptions = {},
  dependencies: NativeProtocolBootstrapDependencies = {},
): Promise<void> {
  if (options.prepareStorageOnly) {
    const config = createConfig({ env: options.env });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loggerFactory = dependencies.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "zcode_protocol",
    },
  });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.zcode_protocol",
  });
  installZCodeProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.zcode_protocol",
      startupKind: "zcode_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("ZCode Protocol agent startup started", {
    context: { version: options.version },
    event: "zcode_protocol.startup.started",
    stage: "start",
  });

  let sessionStore: SqliteSessionStore | undefined;
  let serverForCleanup: ZCodeProtocolAgentServer | undefined;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let mcpPort: McpPort | undefined;
  let mcpTelemetryTracker: McpTelemetryTracker | undefined;
  let mcpResourceSink: ((samples: ZCodeMcpResourceSample[]) => void) | undefined;
  let mcpTelemetrySink: ((event: ZCodeMcpTelemetryEvent) => void) | undefined;
  let processResourceSampler: ZCodeProcessResourceSampler | undefined;
  let providerRegistryRuntime: NativeProtocolRegistryRuntime | undefined;
  try {
    // 数据库准备先于账号、Registry 和遥测，不把远端材料等待混进迁移门禁。
    const configResult = createConfig({ env: options.env });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          // 修复：准备与正常启动曾分别按 launch cwd 和 process.cwd() 解析相对路径，
          // 同一配置会打开两个数据库；二者必须共用唯一的配置与 cwd 语义。
          dbPath: getSessionDbPath(configResult, options.cwd),
          output,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "zcode_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      // 只有可信 Node 调用方能注入真实 Registry runtime；默认启动/账号权益协议不变。
      create: () =>
        (dependencies.startProviderRegistryRuntime ?? startProcessProviderRegistryRuntime)(
          runtimeEnv,
        ),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "zcode_protocol.provider_registry.ready",
      module: "bootstrap.zcode_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    const runtimeSurface = resolveProtocolRuntimeSurface(runtimeEnv);
    const telemetryEnv = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: () => shutdownZCodeTelemetry(),
      create: () =>
        prepareZCodeTelemetryEnv(runtimeEnv, {
          cliVersion: options.version,
          productVersion: options.env?.ZCODE_APP_VERSION,
          runtimeSurface,
        }),
    });
    const telemetryDeviceMid = telemetryEnv.ZCODE_TELEMETRY_DEVICE_MID;
    mcpTelemetryTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpTelemetryTracker({
            idSalt: traceContext.traceId,
            onEvent: (event) => mcpTelemetrySink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    // 官方 MCP 身份头端口：连接池构造早于 server，故用惰性 holder 回填。
    // server 就绪前该端口返回 official_auth_unavailable；HTTP tools/call 会匿名交给服务端
    // 返回结构化权限错误，stdio 则把 reason 下发给插件。连接与工具发现都不受影响。
    let officialMcpAuthContext: OfficialMcpAuthRequestContext | undefined;
    // stdio 官方 MCP 没有 url 可供校验，targetOrigin 只能由宿主给出。
    // 与下面 trustedOrigins 的 resolveZCodeApiOrigin 必须是同一个表达式，否则两侧判定分叉。
    const resolveZCodeApiOrigin = (): string =>
      resolveRuntimeZCodeEndpointOrigin(options.env ?? process.env);
    const workspaceIdentity = (options.env ?? process.env)[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim();
    const officialMcpAuth = {
      authHeadersPort: createOfficialMcpAuthHeadersPort({
        resolveContext: () => officialMcpAuthContext,
        // workspaceKey 必须遵守仓库约定 `workspaceIdentity?.trim() || workspacePath`，
        // 否则同路径不同 identity 的远端 workspace 在审计上下文里无法区分。
        // 注意：agent 进程当前没有 identity 来源，因此实际多为 undefined，key 退化为 path；
        // 详见 official-mcp-auth-port.ts 的"剩余缺口"说明。
        resolveWorkspace: ({ workspaceIdentity, workspacePath }) => {
          const path = workspacePath ?? options.cwd;
          if (!path) return undefined;
          const identity = workspaceIdentity?.trim();
          return {
            ...(identity ? { workspaceIdentity: identity } : {}),
            workspaceKey: identity || path,
            workspacePath: path,
          };
        },
      }),
      resolveZCodeApiOrigin,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // 信任判定只看一条：目标 origin 等于当前 ZCode API origin（https）。pluginId 不参与。
      // origin 运行时解析（跟随 production/test 与自建环境），不硬编码域名。
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: (options.env ?? process.env)[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
        resolveZCodeApiOrigin,
      }),
    };
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            officialMcpAuth,
            telemetry: mcpTelemetryTracker,
            workingDirectory: options.cwd,
          });
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();
    const server = (serverForCleanup = new ZCodeProtocolAgentServer({
      createZCodeApp: (appOptions = {}) =>
        createZCodeApp({
          ...(dependencies.modelAdapter ? { modelAdapter: dependencies.modelAdapter } : {}),
          ...(dependencies.loggerFactory ? { loggerFactory: dependencies.loggerFactory } : {}),
          ...(dependencies.fileSystemPort ? { fileSystemPort: dependencies.fileSystemPort } : {}),
          ...(dependencies.executionPort ? { executionPort: dependencies.executionPort } : {}),
          ...(dependencies.httpClientPort ? { httpClientPort: dependencies.httpClientPort } : {}),
          ...applyProtocolProviderRegistry(
            applyProtocolPresentationSurface(appOptions, presentationSurface),
            activeProviderRegistryRuntime.runtime.registryService,
            activeProviderRegistryRuntime.configuredDefaultModelSelection,
          ),
          // 修复：V4 create 的 runtimeConfig 在组合阶段覆盖了私有 allowlist；
          // 在全部 presentation/provider 合成之后再次收窄，注册前即禁用委派工具。
          ...(dependencies.privateToolAllowlist ? {
            privateToolRegistrationOnly: true,
            runtimeConfig: {
              ...appOptions.runtimeConfig,
              presentationSurface,
              toolAllowlist: [...dependencies.privateToolAllowlist],
              dynamicWorkflowEnabled: false,
            },
          } : {}),
          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。
          resolveEffectiveModelSelection: (selection) => {
            const view = modelSelectionFacade.getView(undefined, undefined, { selection });
            return {
              effectiveSelection: view.effectiveSelection ?? null,
              selectionIssue: view.selectionIssue,
            };
          },
          env: {
            ...telemetryEnv,
            ...appOptions.env,
            ...(telemetryDeviceMid ? { ZCODE_TELEMETRY_DEVICE_MID: telemetryDeviceMid } : {}),
          },
          ...(nodeReplBrowserBroker ? { nodeReplBrowserBroker } : {}),
          ...(mcpConnectionPool
            ? {
                mcpPortFactory: () =>
                  mcpConnectionPool!.acquireLease({
                    leaseId: appOptions.sessionId,
                    sessionId: appOptions.sessionId,
                  }),
              }
            : {}),
          sourceTitle: "electron",
          onToolExecResource: (params) =>
            connection.send({ method: zcodeProtocolNotifications.toolExecResource, params }),
        }),
      cwd: options.cwd,
      env: options.env,
      loggerFactory,
      mcpPort,
      mcpTelemetry: mcpTelemetryTracker,
      sessionStore,
      syncAccountProviderConfig: activeProviderRegistryRuntime.syncAccountProviderConfig,
      refreshProviderRegistry: async (reason) => {
        await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
      },
      version: options.version,
    }));
    officialMcpAuthContext = server.officialMcpAuthRequestContext;
    if (configResult.config.features.mcp !== false) {
      nodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort: server.browserControlPort,
        logger,
        platform: process.platform,
      });
      const broker = nodeReplBrowserBroker;
      await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () => broker.ready,
      });
    }
    const connection = new ZCodeProtocolNdjsonConnection({
      signal: options.lifecycle?.signal,
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      logger,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    server.setNotificationSink((notification) => {
      if ((dependencies.privateNativeTurnObservation || dependencies.privateNativePermissionObservation) && notification.method === "session/event") {
        // 修复：legacy 订阅只用于可信 Native 身份事实；其他 session/event 可能含
        // provider 配置或原文，绝不能为了读取 turn.started 顺带写入私有 stdout。
        const event = notification.params as {
          type?: unknown; sessionId?: unknown; turnId?: unknown;
          payload?: { intent?: { sourceCommandId?: unknown }; inputId?: unknown; messageId?: unknown };
        };
        if (event?.type === "turn.started") {
          const sourceCommandId = event.payload?.intent?.sourceCommandId ?? event.payload?.inputId;
          const productMessageId = event.payload?.messageId;
          if (typeof event.sessionId === "string" && typeof event.turnId === "string" &&
              typeof sourceCommandId === "string" && typeof productMessageId === "string")
            dependencies.privateNativeTurnObservation?.({
              sessionId: event.sessionId, runtimeTurnId: event.turnId,
              sourceCommandId, productMessageId,
            });
        }
        if (event?.type === "permission.requested" && dependencies.privateNativePermissionObservation) {
          const payload = event.payload as typeof event.payload & {
            requestId?: unknown; toolCallId?: unknown; toolName?: unknown; input?: unknown;
          };
          if (typeof event.sessionId === "string" && typeof event.turnId === "string" &&
              typeof payload?.requestId === "string" && typeof payload.toolCallId === "string" &&
              typeof payload.toolName === "string") {
            // 原生 executor 在调用 broker 前发出事实；只投影输入摘要，绝不发送原始工具输入。
            dependencies.privateNativePermissionObservation({
              sessionId: event.sessionId, runtimeTurnId: event.turnId,
              requestId: payload.requestId, toolCallId: payload.toolCallId,
              toolName: payload.toolName,
              inputDigest: createHash("sha256").update(JSON.stringify(payload.input)).digest("hex"),
            });
          }
        }
        return;
      }
      connection.send(notification);
    });
    mcpResourceSink = (samples) =>
      connection.send({
        method: zcodeProtocolNotifications.mcpResourceSamples,
        params: samples,
      });
    mcpTelemetrySink = (event) => {
      // 五分钟资源通知取代旧内存通知；tracker 内部孤儿事实仍保留原判据。
      if (event.kind === "memory") return;
      connection.send({
        method: zcodeProtocolNotifications.mcpTelemetry,
        params: event,
      });
    };
    connection.start();
    mcpTelemetryTracker?.start();
    processResourceSampler = startProtocolResourceSampler(
      server,
      (message) => connection.send(message),
      logger,
    );
    startupTimer.complete("ZCode Protocol agent startup completed", {
      event: "zcode_protocol.startup.completed",
      stage: "total",
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    await connection.waitForClose();
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("ZCode Protocol agent startup failed", error, {
      event: "zcode_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    options.lifecycle?.requestShutdown();
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: serverForCleanup,
      processResourceSampler,
      mcpTelemetryTracker,
      nodeReplBrowserBroker,
      mcpPort,
      mcpConnectionPool,
      sessionStore,
      providerRegistryRuntime,
    });
    logger.info("ZCode Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "zcode_protocol.shutdown.completed",
      module: "bootstrap.zcode_protocol",
      status: "completed",
    });
  }
}

function resolveProtocolRuntimeSurface(
  env: NodeJS.ProcessEnv,
): "desktop_local_host" | "remote_workspace_host" {
  // Bug 根因：入口曾无条件覆盖 Host 注入值，远程 SSH/WSL/容器 Trace 被归入本地 Desktop。
  return env.ZCODE_TELEMETRY_RUNTIME_SURFACE?.trim() === "remote_workspace_host"
    ? "remote_workspace_host"
    : "desktop_local_host";
}
