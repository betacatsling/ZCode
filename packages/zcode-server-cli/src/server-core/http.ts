import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  createZCodeAgentConnectionScope,
  IZCodeAgentService,
  IAgentHostService,
  IProviderProvisioningTargetService,
  getProjectWorkspaceWriteExclusions,
  ServiceCollection,
} from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import { verifyWebSocketUpgrade, type WebSocketUpgradeIncoming } from "@zcode/shared/node";
import {
  createHostCapabilityStore,
  createHostCapabilityUpgradeGate,
  HOST_CAPABILITY_WS_PATH,
  hostBootstrapCredentialFingerprint,
  type HostCapabilityBinding,
  type HostCapabilityStore,
} from "./hostCapability.js";
import {
  createHostBootstrapToken,
  HOST_BOOTSTRAP_TOKEN_PATTERN,
  HOST_CAPABILITY_PATH,
  verifyHostBootstrapRequest,
  verifyLocalEndpointHeaders,
} from "./hostBootstrapAuth.js";

interface CoreHttpServer {
  host: string;
  port: number;
  /** Private per-launch secret required by POST /api/rpc-host-capability. */
  hostBootstrapToken: string;
  close: () => Promise<void>;
}

const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

function incomingOf(context: Context): WebSocketUpgradeIncoming | undefined {
  return (context.env as { incoming?: WebSocketUpgradeIncoming } | undefined)?.incoming;
}

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() 不会收敛已经 upgrade 的 WebSocket，活跃 desktop
    // continuous 连接会让 Core 的 shutdown ack 永远发不出去。先发 close frame 给正常
    // 客户端一个短暂排空窗口，再 terminate 兜底，保证 Supervisor 能在预算内释放资源。
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function wrapWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
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
}

function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, (...args) => log.debug(undefined, ...args));
  const agentService = services.getOptional(IZCodeAgentService);
  const scope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-core-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const excludedChannels = new Set(getProjectWorkspaceWriteExclusions(clientMode));
  if (clientMode !== "desktop-continuous") {
    // 修复依据：外部会话 RPC 只能通过已消费的一次性 host capability 进入；通用 /ws 不能获得 Host 写入与历史读取。
    excludedChannels.add(IAgentHostService.channelName);
    excludedChannels.add(IProviderProvisioningTargetService.channelName);
  }
  services.exposeOnChannelServer(
    server,
    scope ? new Map([[IZCodeAgentService.channelName, scope.service]]) : new Map(),
    excludedChannels,
  );
  socket.onClose(() => {
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    hostCapabilityStore?: HostCapabilityStore;
    /** Private bootstrap secret; generated per launch when omitted so issuance never fails open. */
    hostBootstrapToken?: string;
    /** Core generation; Host tickets are bound to it together with the bootstrap credential. */
    generation?: number;
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    // 当前只有本机/SSH 隧道入口；/ws 与 server-info 没有 token middleware，对外监听必须 fail-closed。
    throw new Error(
      `Non-loopback host ${host} requires authentication before the server can listen`,
    );
  }
  const hostBootstrapToken = options.hostBootstrapToken ?? createHostBootstrapToken();
  if (!HOST_BOOTSTRAP_TOKEN_PATTERN.test(hostBootstrapToken)) {
    throw new Error("Host bootstrap token must be 32 random bytes encoded as base64url");
  }
  const info: ServerRemoteInfo = {
    // 未注入安装级 identity（嵌入/单测）时用常量，不对未鉴权端点公开 os.hostname()。
    serverId: options.serverId ?? "zcode-server",
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    // Host ticket 签发需要私有 bootstrap 凭据（见 docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md）。
    authRequired: true,
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
      agentHost: services.getOptional(IAgentHostService) !== undefined,
    },
  };
  // 裸 Set 无法落实 expiresAt，未消费的 capability 会一直有效并持续累积。
  // 使用与 packages/server 兼容的 TTL 一次性 store，使有效期和消费语义与返回信息一致。
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  // ticket 在 /ws/host middleware 里、ws 同款握手检查全部通过之后才消费（仍在路由之前），
  // 普通请求、会失败的握手、半关闭的客户端或路由不符都不会烧掉它；verifyClient 只放行已准入的请求。
  // ticket 绑定签发它的 bootstrap 凭据指纹与 Core generation；只接受当前绑定，轮换/换代前的 ticket 401。
  const hostCapabilityBinding: HostCapabilityBinding = {
    credentialFingerprint: hostBootstrapCredentialFingerprint(hostBootstrapToken),
    ...(options.generation === undefined ? {} : { generation: options.generation }),
  };
  const acceptedHostCapabilityBindings = [hostCapabilityBinding];
  // /ws/host 与签发端点同一请求头规则（Origin → 403，非回环 Host → 403），先于 ticket 检查。
  const hostRequestHeaderRules = { requireLoopbackHost: true };
  const hostUpgradeGate = createHostCapabilityUpgradeGate(capabilities, {
    acceptedBindings: () => acceptedHostCapabilityBindings,
    ...hostRequestHeaderRules,
  });
  hostUpgradeGate.attach(wss);
  // /ws 与 server-info 无 token：Core 的真实调用方都是 Node（不发 Origin），Core 也不托管网页，
  // 因此任何 Origin → 403、非回环 Host → 403（anti DNS rebinding）。
  const localEndpointHeaderPolicy = { requireLoopbackHost: true, origin: "no-browser" } as const;
  const guardLocalEndpoint: MiddlewareHandler = async (context, next) => {
    const rejection = verifyLocalEndpointHeaders(
      { origin: context.req.header("origin"), host: context.req.header("host") },
      localEndpointHeaderPolicy,
    );
    if (rejection) return context.json({ error: rejection.error }, rejection.status);
    await next();
  };
  app.use("/ws", guardLocalEndpoint);
  app.use("/api/server-info", guardLocalEndpoint);
  app.get("/api/server-info", (context) => context.json(info));
  // @hono/node-ws 在路由里登记的 waiter 只在握手成功时删除：ws 会拒绝的升级（以及没走 upgrade
  // 路径的 Upgrade: websocket）必须在路由之前拒绝，否则请求会一直被留住（见 webSocketUpgrade.ts）。
  app.use("/ws", async (context, next) => {
    const rejection = verifyWebSocketUpgrade(incomingOf(context) ?? { headers: {} });
    if (rejection) return context.json({ error: rejection.error }, rejection.status);
    await next();
  });
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );
  app.use(HOST_CAPABILITY_WS_PATH, async (context, next) => {
    const admission = hostUpgradeGate.admit({
      incoming: incomingOf(context),
      capability: context.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER),
      origin: context.req.header("origin"),
      host: context.req.header("host"),
      upgrade: context.req.header("upgrade"),
      connection: context.req.header("connection"),
    });
    if (!admission.ok) {
      for (const [name, value] of Object.entries(admission.headers ?? {})) {
        context.header(name, value);
      }
      return context.json({ error: admission.error }, admission.status);
    }
    await next();
  });
  app.get(
    HOST_CAPABILITY_WS_PATH,
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "desktop-continuous");
      },
    })),
  );
  app.post(HOST_CAPABILITY_PATH, (context) => {
    // loopback 可达性（本机其他用户、SSH 隧道、DNS rebinding）不是调用者身份：签发前必须校验
    // Supervisor 经私有通道下发的 bootstrap secret，拒绝时不得调用 issue()。
    const verdict = verifyHostBootstrapRequest(
      {
        authorization: context.req.header("authorization"),
        origin: context.req.header("origin"),
        host: context.req.header("host"),
      },
      [hostBootstrapToken],
      hostRequestHeaderRules,
    );
    context.header("Cache-Control", "no-store");
    if (!verdict.ok) return context.json({ error: verdict.error }, verdict.status);
    // 唯一的 Bearer 凭据就是 hostBootstrapToken，通过校验即说明出示的正是它。
    return context.json(hostUpgradeGate.issue(hostCapabilityBinding));
  });
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    hostBootstrapToken,
    close: async () => {
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
