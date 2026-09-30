/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  IAgentHostService,
  getProjectWorkspaceWriteExclusions,
  createZCodeAgentConnectionScope,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IBotsService,
  IProviderProvisioningTargetService,
} from "@zcode/services";
import {
  botProviders,
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  ZCODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@zcode/shared";
import { verifyWebSocketUpgrade, type WebSocketUpgradeIncoming } from "@zcode/shared/node";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import {
  createHostCapabilityStore,
  createHostCapabilityUpgradeGate,
  HOST_CAPABILITY_WS_PATH,
  hostBootstrapCredentialFingerprint,
  type HostCapabilityBinding,
  type HostCapabilityStore,
} from "./hostCapability.js";
import {
  HOST_CAPABILITY_PATH,
  presentedHostBootstrapCredential,
  verifyHostBootstrapRequest,
  verifyLocalEndpointHeaders,
  type LocalEndpointHeaderPolicy,
} from "./hostBootstrapAuth.js";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
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

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(
    server,
    overrides,
    new Set([IAgentHostService.channelName, ...getProjectWorkspaceWriteExclusions(clientMode)]),
  );
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  /** Accepted for compatibility; no longer published by /api/server-info. */
  serverId?: string;
  /** Accepted for compatibility; no longer published by /api/server-info. */
  name?: string;
  host?: string;
  authToken?: string;
  /**
   * Dedicated private secret for POST /api/rpc-host-capability. When omitted, `authToken` (if
   * configured) doubles as the bootstrap credential; with neither, ticket issuance is disabled.
   */
  hostBootstrapToken?: string;
  /** Inject the one-time ticket store (tests); defaults to a fresh TTL store per server. */
  hostCapabilityStore?: HostCapabilityStore;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ZCODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

// `/api/server-info` 未鉴权：只返回真实调用方读取的字段。Web UI（packages/web/src/main.tsx）
// 与分发冒烟只读 workspaces[0].path / workspaceIdentity；serverId（默认 os.hostname()）、
// name 与 label 无人读取，不再公开。
function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    version: ZCODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    // Host ticket 签发始终需要带外 bootstrap 凭据（未配置时直接 401），因此如实报告 true；
    // 仅在配置 authToken 时 /ws 与其他 /api 才受 token middleware 保护。
    authRequired: true,
    workspaces: resolveServerWorkspaces(options).map(({ path, workspaceIdentity }) => ({
      path,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
      processResourceTelemetry: true,
    },
  };
}

const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

function incomingOf(c: Context): WebSocketUpgradeIncoming | undefined {
  return (c.env as { incoming?: WebSocketUpgradeIncoming } | undefined)?.incoming;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isLoopbackBindHost(host: string | undefined): boolean {
  const normalized = host
    ?.trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const hostCapabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  const authToken = options.authToken?.trim();
  const hostBootstrapCredentials = [options.hostBootstrapToken?.trim(), authToken].filter(
    (token): token is string => Boolean(token),
  );
  // ticket 绑定签发时出示的 bootstrap 凭据指纹；/ws/host 只接受当前已配置凭据的绑定，
  // 因而凭据轮换（含 authToken 兼作凭据时）之前签发的 ticket 会被拒绝。未配置凭据时不绑定。
  const acceptedHostCapabilityBindings: HostCapabilityBinding[] | undefined =
    hostBootstrapCredentials.length > 0
      ? hostBootstrapCredentials.map((credential) => ({
          credentialFingerprint: hostBootstrapCredentialFingerprint(credential),
        }))
      : undefined;
  // /ws/host 与签发端点同一请求头规则（Origin → 403；监听回环时非回环 Host → 403），先于 ticket 检查。
  const hostRequestHeaderRules = { requireLoopbackHost: isLoopbackBindHost(options.host) };
  // ticket 在 /ws/host middleware 里、ws 同款握手检查全部通过之后才消费（仍在路由之前），
  // 普通请求、会失败的握手、半关闭的客户端或路由不符都不会烧掉它；verifyClient 只放行已准入的请求。
  const hostUpgradeGate = createHostCapabilityUpgradeGate(hostCapabilities, {
    acceptedBindings: () => acceptedHostCapabilityBindings,
    ...hostRequestHeaderRules,
  });
  hostUpgradeGate.attach(wss);
  // /ws、/ws/remote/* 与 server-info：唯一的浏览器客户端是本 server 托管的 Web UI（同源），
  // Node 客户端不发 Origin；跨站 Origin → 403，监听回环时非回环 Host → 403（与签发端点同一 Host 规则）。
  const localEndpointHeaderPolicy: LocalEndpointHeaderPolicy = {
    ...hostRequestHeaderRules,
    origin: "same-origin",
  };
  const guardLocalEndpoint =
    (policy: LocalEndpointHeaderPolicy): MiddlewareHandler =>
    async (c, next) => {
      const rejection = verifyLocalEndpointHeaders(
        {
          origin: c.req.header("origin"),
          host: c.req.header("host"),
          contentType: c.req.header("content-type"),
        },
        policy,
      );
      if (rejection) return c.json({ error: rejection.error }, rejection.status);
      await next();
    };
  for (const path of ["/ws", "/ws/remote/*", "/api/server-info"]) {
    app.use(path, guardLocalEndpoint(localEndpointHeaderPolicy));
  }
  // connect-remote 有副作用（建立远程连接）：同样的 Origin/Host 规则，另外要求 application/json，
  // 使没有 Origin 的请求只可能来自非浏览器客户端（跨站页面不经 CORS 预检发不出 JSON）。
  app.use(
    "/api/connect-remote",
    guardLocalEndpoint({ ...localEndpointHeaderPolicy, body: "json" }),
  );
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      if (pathname === HOST_CAPABILITY_PATH) {
        // Host ticket 签发有独立且更严格的 Bearer 校验（不接受 cookie/query token），此处不重复拦截。
        await next();
        return;
      }
      const validToken = hasValidLiteToken(c, authToken);
      if (!isTokenProtectedPath(pathname) || validToken) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
  app.post(HOST_CAPABILITY_PATH, (c) => {
    // 只认 Authorization: Bearer；浏览器 cookie/query token 不能换取 trusted-host ticket。
    // 监听回环地址时额外拒绝非回环 Host 头（DNS rebinding）。拒绝时不得调用 issue()。
    const verdict = verifyHostBootstrapRequest(
      {
        authorization: c.req.header("authorization"),
        origin: c.req.header("origin"),
        host: c.req.header("host"),
      },
      hostBootstrapCredentials,
      hostRequestHeaderRules,
    );
    c.header("Cache-Control", "no-store");
    if (!verdict.ok) return c.json({ error: verdict.error }, verdict.status);
    // 校验已通过，出示的 Bearer 必然等于某个已配置凭据；只记录其指纹，绝不记录原文。
    const presented = presentedHostBootstrapCredential(c.req.header("authorization")) ?? "";
    return c.json(
      hostUpgradeGate.issue({
        credentialFingerprint: hostBootstrapCredentialFingerprint(presented),
      }),
    );
  });

  // @hono/node-ws 在路由里登记的 waiter 只在握手成功时删除：ws 会拒绝的升级（以及没走 upgrade
  // 路径的 Upgrade: websocket）必须在路由之前拒绝，否则请求会一直被留住（见 webSocketUpgrade.ts）。
  const guardWebSocketUpgrade: MiddlewareHandler = async (c, next) => {
    const rejection = verifyWebSocketUpgrade(incomingOf(c) ?? { headers: {} });
    if (rejection) return c.json({ error: rejection.error }, rejection.status);
    await next();
  };
  app.use("/ws", guardWebSocketUpgrade);
  app.use("/ws/remote/*", guardWebSocketUpgrade);

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  app.use(HOST_CAPABILITY_WS_PATH, async (c, next) => {
    const admission = hostUpgradeGate.admit({
      incoming: incomingOf(c),
      capability: c.req.header(ZCODE_RPC_HOST_CAPABILITY_HEADER),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
      upgrade: c.req.header("upgrade"),
      connection: c.req.header("connection"),
    });
    if (!admission.ok) {
      for (const [name, value] of Object.entries(admission.headers ?? {})) c.header(name, value);
      return c.json({ error: admission.error }, admission.status);
    }
    await next();
  });
  app.get(HOST_CAPABILITY_WS_PATH, upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: "Invalid request body: malformed JSON" }, 400);
    }
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      remoteConnections.set(id, connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    if (provider !== "webhook") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-zcode-bot-secret");
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    if (result.status === 400) {
      return c.json(responseBody, 400);
    }
    if (result.status === 401) {
      return c.json(responseBody, 401);
    }
    if (result.status === 503) {
      // Bugfix：Bot 业务失败必须把可重试状态透传给 HTTP provider；返回 200 会让
      // webhook/网关误以为消息已消费，效果与提前提交 Telegram offset 相同。
      return c.json(responseBody, 503);
    }
    return c.json(responseBody, 200);
  };

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  const server = serve({ fetch: app.fetch, hostname: options.host, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    const listenHost = options.host?.trim() || "localhost";
    log(`http://${listenHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
