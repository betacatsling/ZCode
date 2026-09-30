/**
 * M3 gap 6 test fixture: an in-process "offline" network guard.
 *
 * Every outbound attempt that is not loopback (127.0.0.0/8, ::1, localhost) or a local IPC path
 * is recorded and rejected the way an unplugged machine would reject it (fetch → TypeError,
 * sockets → ENETUNREACH, dns → ENOTFOUND). Loopback traffic passes through so local fakes and
 * the server under test keep working.
 *
 * Layers (so a zero-count assertion is meaningful even if code captured `fetch` early):
 *  - globalThis.fetch            → records method, URL and header names/values
 *  - http/https.request/get      → records method and URL, then lets the socket layer reject
 *  - net.Socket.prototype.connect → covers net/tls/http(s)/undici sockets; records host:port
 *  - dns.lookup / dns.promises.lookup → records hostnames
 * `syncBuiltinESMExports()` is called so ESM named imports of the builtins see the patches.
 *
 * Not covered: child processes (a spawned shell or CLI has its own network stack), raw UDP
 * (dgram), dns.resolve*, and native addons. Those need an OS-level network namespace.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

export type OutboundLayer = "fetch" | "http" | "socket" | "dns";

export interface OutboundAttempt {
  readonly layer: OutboundLayer;
  readonly target: string;
  readonly host: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** `Date.now()` when recorded; follows node:test mock timers when Date is mocked. */
  readonly at: number;
}

export interface OfflineNetworkGuard {
  readonly attempts: readonly OutboundAttempt[];
  readonly loopback: readonly string[];
  /** Index to slice `attempts` from, so a test can look at only what happened after a point. */
  mark(): number;
  since(mark: number): readonly OutboundAttempt[];
  uninstall(): void;
}

/** Legacy product login / account / renewal / plan surfaces removed by REMOVE-PRODUCT-LOGIN-PLAN. */
export const PRODUCT_LOGIN_HOST_PATTERN = /(^|\.)(chat\.z\.ai|api\.z\.ai|bigmodel\.cn)$/iu;
export const PRODUCT_LOGIN_PATH_PATTERN =
  /\/(oauth2?|authorize|token|refresh|renew|login|logout|userinfo|users?|me|profile|accounts?|subscriptions?|billing|balance|quota|coding-plan|off-peak|biz|monitor\/usage|mcp\/usage|feedback)(\/|\?|$)/iu;
export const PRODUCT_CREDENTIAL_HEADER_PATTERN =
  /^(authorization|cookie|x-coding-plan-api-key|bigmodel-organization|bigmodel-project|zcodejwttoken)$/iu;

/** True when the attempt looks like product auth/renewal/account/plan traffic. */
export function isProductLoginAttempt(attempt: OutboundAttempt): boolean {
  if (PRODUCT_LOGIN_HOST_PATTERN.test(attempt.host)) return true;
  let path = "";
  try {
    path = new URL(attempt.target).pathname;
  } catch {
    path = "";
  }
  if (path && PRODUCT_LOGIN_PATH_PATTERN.test(path)) return true;
  return Object.keys(attempt.headers ?? {}).some((name) =>
    PRODUCT_CREDENTIAL_HEADER_PATTERN.test(name),
  );
}

export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === "") return true; // Node defaults to localhost
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  if (isIP(bare) === 6) return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
  return false;
}

function offlineError(code: "ENETUNREACH" | "ENOTFOUND", host: string): NodeJS.ErrnoException {
  const error = new Error(`offline network guard: ${code} ${host}`) as NodeJS.ErrnoException;
  error.code = code;
  error.syscall = code === "ENOTFOUND" ? "getaddrinfo" : "connect";
  return error;
}

function readRequestUrl(input: unknown): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input === "object" && "url" in input) {
      return new URL(String((input as { url: string }).url));
    }
  } catch {
    return null;
  }
  return null;
}

function headerRecord(headers: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  try {
    new Headers(headers as ConstructorParameters<typeof Headers>[0]).forEach((value, key) => {
      record[key] = value;
    });
  } catch {
    // Unreadable headers are recorded as empty; the URL is still recorded.
  }
  return record;
}

let installed = false;

export function installOfflineNetworkGuard(): OfflineNetworkGuard {
  if (installed) throw new Error("offline network guard is already installed");
  installed = true;
  const attempts: OutboundAttempt[] = [];
  const loopback: string[] = [];
  const record = (attempt: Omit<OutboundAttempt, "at">) =>
    attempts.push({ ...attempt, at: Date.now() });

  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const originalLookup = dns.lookup;
  const originalPromisesLookup = dns.promises.lookup;
  const originalHttpRequest = http.request;
  const originalHttpGet = http.get;
  const originalHttpsRequest = https.request;
  const originalHttpsGet = https.get;

  globalThis.fetch = async function guardedFetch(
    input: Request | string | URL,
    init?: RequestInit,
  ) {
    const url = readRequestUrl(input);
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : undefined) ??
      "GET"
    ).toUpperCase();
    if (url && isLoopbackHost(url.hostname)) {
      loopback.push(`fetch ${method} ${url.href}`);
      return originalFetch(input, init);
    }
    const host = url?.hostname ?? "<unparsed>";
    record({
      layer: "fetch",
      target: url?.href ?? String(input),
      host,
      method,
      headers: headerRecord(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ),
    });
    throw new TypeError("fetch failed", { cause: offlineError("ENOTFOUND", host) });
  } as typeof fetch;

  const wrapRequest = (original: typeof http.request, scheme: "http" | "https") =>
    function guardedRequest(this: unknown, ...args: unknown[]) {
      const [first, second] = args;
      let url: URL | null = null;
      let method = "GET";
      try {
        if (typeof first === "string" || first instanceof URL) {
          url = new URL(String(first));
          if (second && typeof second === "object" && "method" in second) {
            method = String((second as { method?: string }).method ?? "GET");
          }
        } else if (first && typeof first === "object") {
          const options = first as http.RequestOptions;
          const host = options.hostname ?? options.host ?? "localhost";
          url = new URL(
            `${scheme}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}${options.port ? `:${options.port}` : ""}${options.path ?? "/"}`,
          );
          method = options.method ?? "GET";
        }
      } catch {
        url = null;
      }
      if (url && !isLoopbackHost(url.hostname)) {
        record({
          layer: "http",
          target: url.href,
          host: url.hostname,
          method: method.toUpperCase(),
        });
      }
      return (original as (...a: unknown[]) => http.ClientRequest).apply(this, args);
    } as typeof http.request;

  http.request = wrapRequest(originalHttpRequest, "http");
  https.request = wrapRequest(originalHttpsRequest, "https");
  http.get = function guardedGet(...args: Parameters<typeof http.get>) {
    const request = (http.request as (...a: unknown[]) => http.ClientRequest)(...args);
    request.end();
    return request;
  } as typeof http.get;
  https.get = function guardedGet(...args: Parameters<typeof https.get>) {
    const request = (https.request as (...a: unknown[]) => http.ClientRequest)(...args);
    request.end();
    return request;
  } as typeof https.get;

  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const [first, second] = args;
    let host: string | undefined;
    let port: unknown;
    let path: string | undefined;
    if (Array.isArray(first)) {
      // Internal normalized form: [options, callback].
      const options = first[0] as { host?: string; port?: unknown; path?: string };
      host = options?.host;
      port = options?.port;
      path = options?.path;
    } else if (first && typeof first === "object") {
      const options = first as { host?: string; port?: unknown; path?: string };
      host = options.host;
      port = options.port;
      path = options.path;
    } else if (typeof first === "string" && !/^\d+$/u.test(first)) {
      path = first;
    } else {
      port = first;
      host = typeof second === "string" ? second : undefined;
    }
    if (path || isLoopbackHost(host)) {
      loopback.push(`socket ${path ?? `${host ?? "localhost"}:${String(port)}`}`);
      return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    }
    record({ layer: "socket", target: `${host}:${String(port)}`, host: host! });
    process.nextTick(() => this.destroy(offlineError("ENETUNREACH", host!)));
    return this;
  } as typeof net.Socket.prototype.connect;

  dns.lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
    if (isLoopbackHost(hostname)) {
      return (originalLookup as (...a: unknown[]) => void).call(dns, hostname, ...rest);
    }
    record({ layer: "dns", target: hostname, host: hostname });
    const callback = rest.findLast((value) => typeof value === "function") as
      | ((error: NodeJS.ErrnoException) => void)
      | undefined;
    process.nextTick(() => callback?.(offlineError("ENOTFOUND", hostname)));
  } as typeof dns.lookup;
  dns.promises.lookup = async function guardedPromisesLookup(hostname: string, options?: unknown) {
    if (isLoopbackHost(hostname)) {
      return (originalPromisesLookup as (...a: unknown[]) => Promise<unknown>).call(
        dns.promises,
        hostname,
        options,
      );
    }
    record({ layer: "dns", target: hostname, host: hostname });
    throw offlineError("ENOTFOUND", hostname);
  } as typeof dns.promises.lookup;

  syncBuiltinESMExports();

  return {
    attempts,
    loopback,
    mark: () => attempts.length,
    since: (mark) => attempts.slice(mark),
    uninstall() {
      globalThis.fetch = originalFetch;
      net.Socket.prototype.connect = originalConnect;
      dns.lookup = originalLookup;
      dns.promises.lookup = originalPromisesLookup;
      http.request = originalHttpRequest;
      http.get = originalHttpGet;
      https.request = originalHttpsRequest;
      https.get = originalHttpsGet;
      syncBuiltinESMExports();
      installed = false;
    },
  };
}
