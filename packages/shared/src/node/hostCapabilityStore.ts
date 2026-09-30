import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "../server-remote.js";

/**
 * Single shared implementation of the `/ws/host` Host capability ticket (legacy
 * `packages/server` and Server Core `packages/zcode-server-cli` both use it, so their
 * behaviour cannot drift). See docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md.
 *
 * Tickets are short-lived, single-use and live only in the issuing HTTP server's memory.
 * They are consumed only at the moment the WebSocket upgrade is accepted: the HTTP
 * middleware merely checks them (`admit`), and the consume point runs inside the ws
 * server's `verifyClient`, i.e. after ws has validated the handshake and immediately
 * before it writes `101 Switching Protocols`.
 */
export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;
export const HOST_CAPABILITY_WS_PATH = "/ws/host";

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

export interface HostCapabilityStore {
  issue(): ServerRemoteHostCapability;
  /**
   * Atomic single use. The ticket is deleted whatever the outcome (success, expiry or replay);
   * only the first use within the TTL returns true.
   */
  consume(capability: string | undefined): boolean;
  /**
   * Non-consuming check (the ticket exists and is unexpired). Purges expired entries, so an
   * expired ticket stays rejected even if the clock later rewinds. Optional for injected stores;
   * without it the ticket is checked only at the consume point.
   */
  peek?(capability: string | undefined): boolean;
}

export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const expiresByCapability = new Map<string, number>();

  const purgeExpired = (at: number): void => {
    for (const [capability, expiresAt] of expiresByCapability) {
      if (expiresAt <= at) expiresByCapability.delete(capability);
    }
  };

  return {
    issue() {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      expiresByCapability.set(capability, expiresAt);
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return false;
      const consumedAt = now();
      const expiresAt = expiresByCapability.get(capability);
      // 旧 mode header 是可重放的长期提权声明。ticket 无论成功、过期还是重放都先删除，
      // 只有首次且 TTL 内的消费能获得 trusted-host role。
      expiresByCapability.delete(capability);
      purgeExpired(consumedAt);
      return expiresAt !== undefined && expiresAt > consumedAt;
    },
    peek(capability) {
      if (!capability) return false;
      purgeExpired(now());
      // purge 之后仍在表中的条目一定未过期。
      return expiresByCapability.has(capability);
    },
  };
}

export type HostUpgradeAdmission =
  | { ok: true }
  | { ok: false; status: 401 | 426; error: string; headers?: Record<string, string> };

export interface HostUpgradeRequest {
  /** The Node `IncomingMessage` (`c.env.incoming` under @hono/node-server / @hono/node-ws). */
  incoming: object | undefined;
  /** Value of the `x-zcode-rpc-host-capability` header. */
  capability: string | undefined;
  upgrade: string | undefined;
  connection: string | undefined;
}

/** Structural view of a `ws` WebSocketServer, so this package does not depend on `ws`. */
export interface HostUpgradeWebSocketServer {
  options: { verifyClient?: unknown };
}

export interface HostCapabilityUpgradeGate {
  /**
   * Runs in the `/ws/host` HTTP middleware and never consumes the ticket: 401 for a missing,
   * unknown or expired ticket, 426 for a request that is not a WebSocket upgrade. An admitted
   * request is remembered so the consume point can find its ticket.
   */
  admit(request: HostUpgradeRequest): HostUpgradeAdmission;
  /**
   * Installs the consume point as the ws server's `verifyClient` (sync). It runs only after ws
   * accepted the handshake headers and right before 101 is written; a ticket another upgrade
   * already consumed makes ws answer 401 instead of 101. Other routes (`/ws`) pass through.
   */
  attach(server: HostUpgradeWebSocketServer): void;
}

export function createHostCapabilityUpgradeGate(
  store: HostCapabilityStore,
  path: string = HOST_CAPABILITY_WS_PATH,
): HostCapabilityUpgradeGate {
  // IncomingMessage → ticket; WeakMap so requests that never reach the ws handshake
  // (404 route, aborted socket) do not leak.
  const admitted = new WeakMap<object, string>();
  return {
    admit({ incoming, capability, upgrade, connection }) {
      if (!capability || store.peek?.(capability) === false) {
        return { ok: false, status: 401, error: "Invalid or expired host capability" };
      }
      if (!incoming || !isWebSocketUpgrade(upgrade, connection)) {
        return {
          ok: false,
          status: 426,
          error: "WebSocket upgrade required",
          headers: { Upgrade: "websocket", Connection: "Upgrade" },
        };
      }
      admitted.set(incoming, capability);
      return { ok: true };
    },
    attach(server) {
      if (server.options.verifyClient) {
        throw new Error(
          "Host capability upgrade gate requires a WebSocket server without verifyClient",
        );
      }
      const verifyClient = (info: { req: { url?: string } }): boolean => {
        const capability = admitted.get(info.req);
        if (capability === undefined) return !isPath(info.req.url, path);
        admitted.delete(info.req);
        return store.consume(capability);
      };
      server.options.verifyClient = verifyClient;
    },
  };
}

function isWebSocketUpgrade(upgrade: string | undefined, connection: string | undefined): boolean {
  if (upgrade?.trim().toLowerCase() !== "websocket") return false;
  return (connection ?? "").split(",").some((token) => token.trim().toLowerCase() === "upgrade");
}

function isPath(url: string | undefined, path: string): boolean {
  try {
    return new URL(url ?? "/", "http://localhost").pathname === path;
  } catch {
    return false;
  }
}
