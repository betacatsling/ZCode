import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Host capability bootstrap authentication (docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md).
 *
 * `POST /api/rpc-host-capability` mints a one-time `/ws/host` ticket that upgrades a socket to
 * `trusted-host-relay`. Loopback reachability (local users, SSH tunnels, DNS rebinding) is not
 * caller identity, so issuance requires a private bootstrap secret delivered out of band and
 * presented as `Authorization: Bearer <secret>`. Browser-originated requests are refused outright.
 *
 * Single shared implementation for the legacy server and Server Core (both keep a re-export at
 * their historical `hostBootstrapAuth.ts` path). {@link verifyHostRequestHeaders} is also applied,
 * unchanged, to the `/ws/host` upgrade by the Host capability upgrade gate.
 */

export const HOST_CAPABILITY_PATH = "/api/rpc-host-capability";
/** 32 random bytes, base64url without padding. */
export const HOST_BOOTSTRAP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const BEARER_PATTERN = /^Bearer ([\x21-\x7e]{1,1024})$/iu;

export function createHostBootstrapToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time over the digest so neither content nor length of the secret leaks via timing. */
export function hostBootstrapTokenMatches(expected: string, presented: string): boolean {
  return timingSafeEqual(digest(expected), digest(presented));
}

/** The credential carried by `Authorization: Bearer <credential>`, if well-formed. */
export function presentedHostBootstrapCredential(
  authorization: string | undefined,
): string | undefined {
  return authorization ? BEARER_PATTERN.exec(authorization)?.[1] : undefined;
}

export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (!authority) return false;
  const match = /^(\[::1\]|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/iu.exec(authority.trim());
  if (!match) return false;
  return match[2] === undefined || Number(match[2]) <= 65535;
}

export interface HostRequestHeaders {
  origin: string | undefined;
  host: string | undefined;
}

export interface HostBootstrapRequest extends HostRequestHeaders {
  authorization: string | undefined;
}

export type HostBootstrapVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string; reason: HostBootstrapRejectReason };

export type HostBootstrapRejectReason =
  | "browser-origin"
  | "non-loopback-host"
  | "not-configured"
  | "missing-credential"
  | "invalid-credential";

export interface HostRequestHeaderRejection {
  ok: false;
  status: 403;
  error: string;
  reason: "browser-origin" | "non-loopback-host";
}

export interface HostRequestHeaderOptions {
  /** Refuse a `Host` authority that is not 127.0.0.1 / localhost / [::1] (DNS rebinding). */
  requireLoopbackHost: boolean;
}

/**
 * The browser/authority rule shared by `POST /api/rpc-host-capability` and the `/ws/host`
 * upgrade: any `Origin` → 403, and (when required) a non-loopback `Host` → 403. Returns
 * `undefined` when the headers are acceptable.
 */
export function verifyHostRequestHeaders(
  request: HostRequestHeaders,
  options: HostRequestHeaderOptions,
): HostRequestHeaderRejection | undefined {
  // Legitimate callers are Node processes (Desktop Host, SSH connector, CLI scripts); any Origin
  // header means a browser context, which covers cross-origin fetches to loopback and rebinding.
  if (request.origin !== undefined) {
    return {
      ok: false,
      status: 403,
      error: "Host capability requests from browser origins are not allowed",
      reason: "browser-origin",
    };
  }
  if (options.requireLoopbackHost && !isLoopbackAuthority(request.host)) {
    return {
      ok: false,
      status: 403,
      error: "Host capability requests must address a loopback authority",
      reason: "non-loopback-host",
    };
  }
  return undefined;
}

/**
 * How an unauthenticated local endpoint (`/ws`, `/api/server-info`) treats `Origin`:
 * - `"no-browser"`: every real client is a Node process, so any `Origin` → 403 (Server Core).
 * - `"same-origin"`: the server also hosts its own Web UI, so an `Origin` is accepted only when it
 *   is exactly `http(s)://<Host>`, i.e. the page this server served (legacy server).
 */
export type LocalEndpointOriginPolicy = "no-browser" | "same-origin";

export interface LocalEndpointHeaderPolicy extends HostRequestHeaderOptions {
  origin: LocalEndpointOriginPolicy;
}

export interface LocalEndpointHeaderRejection {
  ok: false;
  status: 403;
  error: string;
  reason: "browser-origin" | "cross-origin" | "non-loopback-host";
}

/** `Origin` is a serialized http(s) origin whose authority equals the `Host` header. */
export function isSameOriginAsHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // Only an exact origin serialization (what browsers send): no path, userinfo or default port.
    if (parsed.origin !== origin) return false;
    // Normalise the Host header with the Origin's scheme so default ports compare equal.
    return new URL(`${parsed.protocol}//${host.trim()}`).host === parsed.host;
  } catch {
    return false;
  }
}

/**
 * Browser / DNS-rebinding guard for local endpoints that are not token-authenticated. Same Host
 * rule as {@link verifyHostRequestHeaders}; the Origin rule depends on who the real clients are.
 */
export function verifyLocalEndpointHeaders(
  request: HostRequestHeaders,
  policy: LocalEndpointHeaderPolicy,
): LocalEndpointHeaderRejection | undefined {
  if (request.origin !== undefined) {
    if (policy.origin === "no-browser") {
      return {
        ok: false,
        status: 403,
        error: "Requests from browser origins are not allowed",
        reason: "browser-origin",
      };
    }
    if (!isSameOriginAsHost(request.origin, request.host)) {
      return {
        ok: false,
        status: 403,
        error: "Cross-origin requests are not allowed",
        reason: "cross-origin",
      };
    }
  }
  if (policy.requireLoopbackHost && !isLoopbackAuthority(request.host)) {
    return {
      ok: false,
      status: 403,
      error: "Requests must address a loopback authority",
      reason: "non-loopback-host",
    };
  }
  return undefined;
}

export function verifyHostBootstrapRequest(
  request: HostBootstrapRequest,
  expectedTokens: readonly string[],
  options: HostRequestHeaderOptions,
): HostBootstrapVerdict {
  const headerRejection = verifyHostRequestHeaders(request, options);
  if (headerRejection) return headerRejection;
  const expected = expectedTokens.filter((token) => token.length > 0);
  const presented = presentedHostBootstrapCredential(request.authorization);
  if (expected.length === 0) {
    return {
      ok: false,
      status: 401,
      error: "Host capability bootstrap credential is not configured",
      reason: "not-configured",
    };
  }
  if (presented === undefined) {
    return {
      ok: false,
      status: 401,
      error: "Host capability bootstrap credential required",
      reason: "missing-credential",
    };
  }
  let matched = false;
  for (const token of expected) {
    // Compare against every configured credential so timing does not reveal which one matched.
    matched = hostBootstrapTokenMatches(token, presented) || matched;
  }
  return matched
    ? { ok: true }
    : {
        ok: false,
        status: 401,
        error: "Invalid host capability bootstrap credential",
        reason: "invalid-credential",
      };
}
