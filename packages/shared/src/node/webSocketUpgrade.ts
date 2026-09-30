/**
 * Pre-route validation of WebSocket upgrades, shared by the legacy server and Server Core.
 *
 * `@hono/node-ws` (1.3.x) registers a "waiter" for the Node `IncomingMessage` inside the route
 * handler (`upgradeWebSocket`) and removes it only when the `ws` server emits `connection`, i.e.
 * when the handshake succeeds. A request that reaches the route and is then refused by `ws`
 * (method, `Sec-WebSocket-Key`/`-Version`, subprotocols, `verifyClient`, a half-closed socket) or
 * that is not on the upgrade path at all keeps its waiter, request, socket and Hono context in a
 * strong `Map` for the life of the server. Middleware therefore refuses every such request
 * *before* the route, with the status `ws` would have used, so no waiter is ever created for it.
 *
 * The rules below mirror `ws` 8.x `WebSocketServer#handleUpgrade` for a server created the way
 * `@hono/node-ws` creates it (`noServer`, no `path`, `perMessageDeflate: false`, so extensions
 * are ignored). `webSocketUpgradeLeak.test.ts` checks the statuses against a bare `ws` server.
 * See docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md ("Upgrade waiters").
 */

/** Structural view of the Node `IncomingMessage` (`c.env.incoming` under @hono/node-server/-ws). */
export interface WebSocketUpgradeIncoming {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  socket?: { readable: boolean; writable: boolean } | null | undefined;
}

export interface WebSocketUpgradeRejection {
  status: 400 | 405 | 426;
  error: string;
}

const KEY_PATTERN = /^[+/0-9A-Za-z]{22}==$/u;
// RFC 7230 token list with optional whitespace around commas; no leading/trailing whitespace.
const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const SUBPROTOCOL_LIST = new RegExp(`^${TOKEN}(?:[ \\t]*,[ \\t]*${TOKEN})*$`, "u");

function header(incoming: WebSocketUpgradeIncoming, name: string): string | undefined {
  const value = incoming.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** `Upgrade: websocket` plus a `Connection: upgrade` token: exactly what Node routes to `upgrade`. */
export function isWebSocketUpgradeRequest(
  upgrade: string | undefined,
  connection: string | undefined,
): boolean {
  if (upgrade?.trim().toLowerCase() !== "websocket") return false;
  return (connection ?? "").split(",").some((token) => token.trim().toLowerCase() === "upgrade");
}

function isValidSubprotocolList(value: string): boolean {
  if (!SUBPROTOCOL_LIST.test(value)) return false;
  const protocols = value.split(",").map((protocol) => protocol.trim());
  return new Set(protocols).size === protocols.length;
}

/**
 * Returns the rejection `ws` (or the missing upgrade path) would produce, or `undefined` when the
 * request is not a WebSocket upgrade attempt at all (`@hono/node-ws` then registers no waiter)
 * or when `ws` will accept the handshake.
 */
export function verifyWebSocketUpgrade(
  incoming: WebSocketUpgradeIncoming,
): WebSocketUpgradeRejection | undefined {
  const upgrade = header(incoming, "upgrade");
  // Same test as @hono/node-ws's upgradeWebSocket: anything else never registers a waiter.
  if (upgrade?.toLowerCase() !== "websocket") return undefined;
  if (!isWebSocketUpgradeRequest(upgrade, header(incoming, "connection"))) {
    // Plain HTTP path: no `upgrade` event will ever resolve the waiter.
    return { status: 426, error: "WebSocket upgrade requires Connection: Upgrade" };
  }
  if (incoming.method !== "GET") return { status: 405, error: "Invalid HTTP method" };
  if (!KEY_PATTERN.test(header(incoming, "sec-websocket-key") ?? "")) {
    return { status: 400, error: "Missing or invalid Sec-WebSocket-Key header" };
  }
  const version = Number(header(incoming, "sec-websocket-version"));
  if (version !== 13 && version !== 8) {
    return { status: 400, error: "Missing or invalid Sec-WebSocket-Version header" };
  }
  const protocols = header(incoming, "sec-websocket-protocol");
  if (protocols !== undefined && !isValidSubprotocolList(protocols)) {
    return { status: 400, error: "Invalid Sec-WebSocket-Protocol header" };
  }
  // ws destroys a socket the client has already half-closed, without calling back.
  if (incoming.socket && (!incoming.socket.readable || !incoming.socket.writable)) {
    return { status: 400, error: "Connection closed before the WebSocket upgrade" };
  }
  return undefined;
}
