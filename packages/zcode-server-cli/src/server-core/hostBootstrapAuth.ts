import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Host capability bootstrap authentication (docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md).
 *
 * `POST /api/rpc-host-capability` mints a one-time `/ws/host` ticket that upgrades a socket to
 * `trusted-host-relay`. Loopback reachability (local users, SSH tunnels, DNS rebinding) is not
 * caller identity, so issuance requires a private bootstrap secret delivered out of band and
 * presented as `Authorization: Bearer <secret>`. Browser-originated requests are refused outright.
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

export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (!authority) return false;
  const match = /^(\[::1\]|127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/iu.exec(authority.trim());
  if (!match) return false;
  return match[2] === undefined || Number(match[2]) <= 65535;
}

export interface HostBootstrapRequest {
  authorization: string | undefined;
  origin: string | undefined;
  host: string | undefined;
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

export function verifyHostBootstrapRequest(
  request: HostBootstrapRequest,
  expectedTokens: readonly string[],
  options: { requireLoopbackHost: boolean },
): HostBootstrapVerdict {
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
  const expected = expectedTokens.filter((token) => token.length > 0);
  const presented = request.authorization
    ? BEARER_PATTERN.exec(request.authorization)?.[1]
    : undefined;
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
