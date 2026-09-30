/**
 * M3 gap 6 (REMOVE-PRODUCT-LOGIN-PLAN §7 rows 1 and 11), server entry path.
 *
 * Replays `entry-http.ts` main() in-process — materialize the bundled Built-in config, the same
 * `createLocalServices` options, `createHttpServer` — while every non-loopback socket, fetch and
 * DNS lookup is recorded and rejected. Leftover product-login credentials sit in the data dir.
 * The fuller workspace/history/idle evidence lives in
 * packages/services/test/m3Gap6OfflineStartupIdleNetwork.test.ts; this file proves the HTTP
 * server entry itself starts and serves offline and adds no outbound traffic of its own.
 */
import assert from "node:assert/strict";
import dns from "node:dns";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

interface Outbound {
  layer: "fetch" | "socket" | "dns";
  host: string;
  target: string;
  method?: string;
  headerNames?: string[];
}

function isLoopback(host: string | undefined): boolean {
  if (!host) return true;
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || bare.startsWith("127.");
}

// ---- Minimal offline guard (fetch + every net/tls socket + dns.lookup). ----
const outbound: Outbound[] = [];
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalLookup = dns.lookup;
globalThis.fetch = async (input: Request | string | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (isLoopback(url.hostname)) return originalFetch(input, init);
  outbound.push({
    layer: "fetch",
    host: url.hostname,
    target: url.href,
    method: (init?.method ?? "GET").toUpperCase(),
    headerNames: [...new Headers(init?.headers).keys()],
  });
  throw new TypeError("fetch failed (offline guard)");
};
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = (Array.isArray(args[0]) ? args[0][0] : args[0]) as
    | { host?: string; port?: unknown; path?: string }
    | number
    | string;
  const options =
    typeof first === "object" && first !== null
      ? first
      : typeof first === "string" && !/^\d+$/u.test(first)
        ? { path: first }
        : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
  if (options.path || isLoopback(options.host)) {
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  }
  outbound.push({
    layer: "socket",
    host: options.host!,
    target: `${options.host}:${String(options.port)}`,
  });
  process.nextTick(() => this.destroy(new Error("ENETUNREACH (offline guard)")));
  return this;
} as typeof net.Socket.prototype.connect;
dns.lookup = function (hostname: string, ...rest: unknown[]) {
  if (isLoopback(hostname)) {
    return (originalLookup as (...a: unknown[]) => void).call(dns, hostname, ...rest);
  }
  outbound.push({ layer: "dns", host: hostname, target: hostname });
  const callback = [...rest].reverse().find((value) => typeof value === "function") as
    | ((error: Error) => void)
    | undefined;
  process.nextTick(() => callback?.(new Error("ENOTFOUND (offline guard)")));
} as typeof dns.lookup;
syncBuiltinESMExports();

// ---- Temp home with product-login leftovers; must be set before services load. ----
const root = mkdtempSync(join(tmpdir(), "zcode-m3-gap6-server-"));
process.env.HOME = root;
process.env.ZCODE_DATA_BASE_DIR = root;
process.env.ZCODE_DESKTOP_HOME_DIR = root;
for (const key of ["ZCODE_BASE_URL", "ZCODE_ENDPOINT_ORIGIN", "HTTP_PROXY", "HTTPS_PROXY"]) {
  delete process.env[key];
}
const LEGACY_JWT = "legacy-product-jwt-must-never-be-sent";
const credentials = `${JSON.stringify({
  "oauth:active_provider": 1,
  "oauth:zai:access_token": LEGACY_JWT,
  "oauth:zai:refresh_token": "legacy-refresh",
  zcodejwttoken: LEGACY_JWT,
  "account-provider:zai:api-key": "legacy-derived-plan-key",
})}\n`;
mkdirSync(join(root, ".zcode", "v2"), { recursive: true });
writeFileSync(join(root, ".zcode", "v2", "credentials.json"), credentials);
writeFileSync(
  join(root, ".zcode", "v2", "setting.json"),
  JSON.stringify({ providerFamilyDomain: "zai", providerFamilyDomainMigrated: true }),
);

const { createLocalServices, disposeServiceResourcesAndWait, getAppConfigDir } =
  await import("@zcode/services/node");
const { materializeBundledZCodeBuiltinProviderConfig } =
  await import("./bundledZCodeBuiltinProviderConfig.js");
const { createHttpServer } = await import("./http.js");

after(async () => {
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
  dns.lookup = originalLookup;
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

test("offline guard positive control: product token call and raw socket are recorded", async () => {
  const before = outbound.length;
  await assert.rejects(fetch("https://chat.z.ai/api/oauth/token", { method: "POST" }));
  await new Promise<void>((resolve) => {
    net.connect({ host: "203.0.113.9", port: 443 }).on("error", () => resolve());
  });
  assert.deepEqual(
    outbound.slice(before).map(({ layer, host }) => `${layer}:${host}`),
    ["fetch:chat.z.ai", "socket:203.0.113.9"],
  );
});

test("standalone HTTP server entry starts offline, serves loopback, and only makes the anonymous Built-in config check", async () => {
  const before = outbound.length;
  const bundledPath = fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  );
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readFileSync(bundledPath, "utf8"),
  });
  const authToken = "offline-test-server-token";
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    serviceAuthorityMode: "standalone-server",
    agentHostTargetId: "m3-gap6-server",
    providerProvisioningTargetEnabled: true,
  });
  let server: Server | undefined;
  try {
    server = createHttpServer(services, 0, {
      serverId: "m3-gap6-server",
      host: "127.0.0.1",
      authToken,
    }) as unknown as Server;
    await new Promise<void>((resolve) =>
      server!.listening ? resolve() : server!.once("listening", () => resolve()),
    );
    const { port } = server.address() as AddressInfo;
    const info = await fetch(`http://127.0.0.1:${port}/api/server-info?token=${authToken}`);
    assert.equal(info.status, 200);
    // Only the shape matters here; #339 trimmed the fields (serverId/name are no longer public).
    assert.equal(typeof ((await info.json()) as { version?: unknown }).version, "string");
    // Offline does not turn protected endpoints anonymous.
    const anonymous = await fetch(`http://127.0.0.1:${port}/api/server-info`);
    assert.equal(anonymous.status, 401);
    // Host ticket issuance still needs the bootstrap secret, even with the server token.
    const ticket = await fetch(
      `http://127.0.0.1:${port}/api/rpc-host-capability?token=${authToken}`,
      { method: "POST" },
    );
    assert.equal(ticket.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } finally {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await disposeServiceResourcesAndWait(services);
  }

  const observed = outbound.slice(before);
  assert.deepEqual(
    observed.map(({ layer, method, target }) => {
      const url = new URL(target);
      return `${layer} ${method} ${url.origin}${url.pathname} ${[...url.searchParams.keys()].sort().join(",")}`;
    }),
    ["fetch GET https://zcode.z.ai/api/v1/client/configs app_version,platform"],
  );
  assert.equal(observed[0]?.headerNames?.includes("authorization"), false);
  assert.equal(observed[0]?.headerNames?.includes("cookie"), false);
  assert.equal(JSON.stringify(observed).includes(LEGACY_JWT), false);
  assert.equal(
    readFileSync(join(root, ".zcode", "v2", "credentials.json"), "utf8"),
    credentials,
    "legacy login material is neither used nor erased",
  );
});
