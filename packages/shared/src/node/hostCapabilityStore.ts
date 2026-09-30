import { createHash, randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "../server-remote.js";
import { verifyHostRequestHeaders } from "./hostBootstrapAuth.js";

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
 *
 * Tickets issued by `POST /api/rpc-host-capability` are bound to the bootstrap credential that
 * authorised them (a fingerprint, never the secret) and, on Server Core, to the Core generation.
 * `/ws/host` only accepts a ticket whose binding is one of the server's *current* bindings, so a
 * ticket obtained before a credential rotation or from another generation is rejected.
 */
export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;
export const HOST_CAPABILITY_WS_PATH = "/ws/host";

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

/** What a ticket is bound to. Never contains the bootstrap secret itself. */
export interface HostCapabilityBinding {
  /** {@link hostBootstrapCredentialFingerprint} of the credential presented at issue. */
  credentialFingerprint: string;
  /** Server Core generation; absent on servers without generations (legacy server). */
  generation?: number;
}

/**
 * The bindings a server currently accepts. `undefined` means the server has no bootstrap
 * credential configured, so no ticket can be bound and none is checked.
 */
export type HostCapabilityBindingPolicy = readonly HostCapabilityBinding[] | undefined;

export interface HostCapabilityStore {
  /**
   * Stores that honour `binding` in `issue` and `accepted` in `peek`/`consume` set this. Stores
   * without it are treated as binding-unaware and wrapped fail-closed by the upgrade gate.
   */
  readonly bindsCredential?: true;
  /**
   * `binding` is recorded with the ticket. Omitted only for in-process issuance by code holding
   * the store; the HTTP issuance endpoint always binds.
   */
  issue(binding?: HostCapabilityBinding): ServerRemoteHostCapability;
  /**
   * Atomic single use. The ticket is deleted whatever the outcome (success, expiry, replay or
   * binding mismatch); only the first use within the TTL whose binding is accepted returns true.
   */
  consume(capability: string | undefined, accepted?: HostCapabilityBindingPolicy): boolean;
  /**
   * Non-consuming check (the ticket exists, is unexpired and its binding is accepted). Purges
   * expired entries, so an expired ticket stays rejected even if the clock later rewinds. Optional
   * for injected stores; without it the ticket is checked only at the consume point.
   */
  peek?(capability: string | undefined, accepted?: HostCapabilityBindingPolicy): boolean;
}

const CREDENTIAL_FINGERPRINT_DOMAIN = "zcode/host-bootstrap-credential/v1\0";

/**
 * Domain-separated SHA-256 of a bootstrap credential (base64url). One-way, so storing it with a
 * ticket does not store the secret; deterministic, so rotation changes it.
 */
export function hostBootstrapCredentialFingerprint(credential: string): string {
  return createHash("sha256")
    .update(CREDENTIAL_FINGERPRINT_DOMAIN, "utf8")
    .update(credential, "utf8")
    .digest("base64url");
}

/**
 * A ticket's binding is accepted when the server has no binding policy, when the ticket was
 * issued unbound in-process, or when it equals one of the server's current bindings exactly.
 */
export function isHostCapabilityBindingAccepted(
  binding: HostCapabilityBinding | undefined,
  accepted: HostCapabilityBindingPolicy,
): boolean {
  if (accepted === undefined || binding === undefined) return true;
  return accepted.some(
    (current) =>
      current.credentialFingerprint === binding.credentialFingerprint &&
      current.generation === binding.generation,
  );
}

export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const tickets = new Map<string, { expiresAt: number; binding?: HostCapabilityBinding }>();

  const purgeExpired = (at: number): void => {
    for (const [capability, ticket] of tickets) {
      if (ticket.expiresAt <= at) tickets.delete(capability);
    }
  };

  return {
    bindsCredential: true,
    issue(binding) {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      tickets.set(capability, binding ? { expiresAt, binding: { ...binding } } : { expiresAt });
      return { capability, expiresAt };
    },
    consume(capability, accepted) {
      if (!capability) return false;
      const consumedAt = now();
      const ticket = tickets.get(capability);
      // 旧 mode header 是可重放的长期提权声明。ticket 无论成功、过期、重放还是绑定不符都先删除，
      // 只有首次、TTL 内且绑定仍是当前凭据的消费能获得 trusted-host role。
      tickets.delete(capability);
      purgeExpired(consumedAt);
      return (
        ticket !== undefined &&
        ticket.expiresAt > consumedAt &&
        isHostCapabilityBindingAccepted(ticket.binding, accepted)
      );
    },
    peek(capability, accepted) {
      if (!capability) return false;
      purgeExpired(now());
      // purge 之后仍在表中的条目一定未过期；绑定不符只拒绝、不删除。
      const ticket = tickets.get(capability);
      return ticket !== undefined && isHostCapabilityBindingAccepted(ticket.binding, accepted);
    },
  };
}

export type HostUpgradeAdmission =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 426; error: string; headers?: Record<string, string> };

export interface HostUpgradeRequest {
  /** The Node `IncomingMessage` (`c.env.incoming` under @hono/node-server / @hono/node-ws). */
  incoming: object | undefined;
  /** Value of the `x-zcode-rpc-host-capability` header. */
  capability: string | undefined;
  /** `Origin` and `Host` headers, checked exactly like `POST /api/rpc-host-capability`. */
  origin: string | undefined;
  host: string | undefined;
  upgrade: string | undefined;
  connection: string | undefined;
}

/** Structural view of a `ws` WebSocketServer, so this package does not depend on `ws`. */
export interface HostUpgradeWebSocketServer {
  options: { verifyClient?: unknown };
}

export interface HostCapabilityUpgradeGateOptions {
  path?: string;
  /**
   * Same value the server passes to `verifyHostBootstrapRequest` for the issue endpoint: refuse
   * a non-loopback `Host` (DNS rebinding). Defaults to true; `Origin` is always refused.
   */
  requireLoopbackHost?: boolean;
  /**
   * The server's current bindings, read at every check so a credential rotated in-process takes
   * effect immediately. Omit (or return `undefined`) when no bootstrap credential is configured.
   */
  acceptedBindings?: () => HostCapabilityBindingPolicy;
}

export interface HostCapabilityUpgradeGate {
  /**
   * The only issuance path servers use: records `binding` with the ticket. For binding-unaware
   * injected stores the gate keeps the binding itself (see {@link createHostCapabilityUpgradeGate}).
   */
  issue(binding: HostCapabilityBinding | undefined): ServerRemoteHostCapability;
  /**
   * Runs in the `/ws/host` HTTP middleware and never consumes the ticket. In order: 403 for any
   * `Origin` or a non-loopback `Host` (the issue endpoint's rule, checked before the ticket is
   * even looked at), 401 for a missing, unknown, expired or no-longer-current-binding ticket, 426
   * for a request that is not a WebSocket upgrade. An admitted request is remembered so the
   * consume point can find its ticket.
   */
  admit(request: HostUpgradeRequest): HostUpgradeAdmission;
  /**
   * Installs the consume point as the ws server's `verifyClient` (sync). It runs only after ws
   * accepted the handshake headers and right before 101 is written; a ticket another upgrade
   * already consumed (or whose binding stopped being current) makes ws answer 401 instead of 101.
   * Other routes (`/ws`) pass through.
   */
  attach(server: HostUpgradeWebSocketServer): void;
}

/**
 * Injected stores that predate binding (no `bindsCredential`) cannot record a binding, and a
 * ticket without one would be indistinguishable from a ticket issued under another credential
 * sharing the store. The gate therefore keeps the bindings of the tickets it issued itself and,
 * while a binding policy is configured, fails closed: a ticket this gate has no record of is
 * rejected (without touching the inner store, so nothing is burned).
 */
function bindingAwareStore(store: HostCapabilityStore): HostCapabilityStore {
  if (store.bindsCredential === true) return store;
  const issued = new Map<string, { expiresAt: number; binding?: HostCapabilityBinding }>();
  const recordAccepted = (capability: string, accepted: HostCapabilityBindingPolicy): boolean => {
    if (accepted === undefined) return true;
    const record = issued.get(capability);
    return record !== undefined && isHostCapabilityBindingAccepted(record.binding, accepted);
  };
  return {
    bindsCredential: true,
    issue(binding) {
      const ticket = store.issue();
      // 只用于回收本表：TTL 的判定权仍在内层 store。
      const now = Date.now();
      for (const [capability, record] of issued) {
        if (record.expiresAt <= now) issued.delete(capability);
      }
      const { expiresAt } = ticket;
      issued.set(
        ticket.capability,
        binding ? { expiresAt, binding: { ...binding } } : { expiresAt },
      );
      return ticket;
    },
    consume(capability, accepted) {
      if (!capability) return false;
      const bound = recordAccepted(capability, accepted);
      issued.delete(capability);
      // 与内层语义一致：不论绑定是否相符，消费点都会烧掉 ticket。
      return store.consume(capability) && bound;
    },
    peek(capability, accepted) {
      if (!capability || !recordAccepted(capability, accepted)) return false;
      return store.peek?.(capability) !== false;
    },
  };
}

export function createHostCapabilityUpgradeGate(
  injectedStore: HostCapabilityStore,
  options: HostCapabilityUpgradeGateOptions = {},
): HostCapabilityUpgradeGate {
  const path = options.path ?? HOST_CAPABILITY_WS_PATH;
  const acceptedBindings = options.acceptedBindings ?? (() => undefined);
  const requireLoopbackHost = options.requireLoopbackHost ?? true;
  const store = bindingAwareStore(injectedStore);
  // IncomingMessage → ticket; WeakMap so requests that never reach the ws handshake
  // (404 route, aborted socket) do not leak.
  const admitted = new WeakMap<object, string>();
  return {
    issue(binding) {
      return store.issue(binding);
    },
    admit({ incoming, capability, origin, host, upgrade, connection }) {
      // 头部规则必须先于任何 ticket peek/consume：被拒绝的浏览器 / rebinding 请求不能烧掉 ticket。
      const headerRejection = verifyHostRequestHeaders({ origin, host }, { requireLoopbackHost });
      if (headerRejection) {
        return { ok: false, status: headerRejection.status, error: headerRejection.error };
      }
      if (!capability || store.peek?.(capability, acceptedBindings()) === false) {
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
        return store.consume(capability, acceptedBindings());
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
