import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  serverRemoteHostCapabilitySchema,
  type ServerRemoteHostCapability,
} from "@zcode/shared";
import { WebSocket } from "ws";
import { DEFAULT_HOST_CAPABILITY_TTL_MS, createHostCapabilityStore } from "./hostCapability.js";
import { createHttpServer } from "./http.js";

// 旧 server `/ws/host` 一次性 ticket 的消费、重放与过期合同。
//
// 第一部分直接测试 `/ws/host` middleware 唯一调用的 HostCapabilityStore.consume()，
// ticket 由 store.issue() 构造，不依赖签发端点，对签发鉴权改造（Ex2）无耦合。
//
// 第二部分走真实 createHttpServer：该函数内部自建 store 且不支持注入，只能通过
// `/api/rpc-host-capability` 拿 ticket。这一耦合集中在 issueTicketViaHttp()；
// 签发端点加鉴权后只需在这一个 helper 里补凭据。

const T0 = 1_000_000;

function createClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

function sequentialCapabilities(prefix = "ticket"): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

// ---------------------------------------------------------------------------
// Store 层
// ---------------------------------------------------------------------------

test("store: issue returns a schema-valid ticket that expires after the default TTL", () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  const issued = store.issue();
  assert.deepEqual(serverRemoteHostCapabilitySchema.parse(issued), issued);
  assert.equal(issued.expiresAt, T0 + DEFAULT_HOST_CAPABILITY_TTL_MS);
  assert.equal(DEFAULT_HOST_CAPABILITY_TTL_MS, 30_000);
  assert.match(issued.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(store.issue().capability, issued.capability);
});

test("store: a valid ticket is consumed exactly once; replay is rejected", () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  const { capability } = store.issue();
  assert.equal(store.consume(capability), true);
  assert.equal(store.consume(capability), false);
  assert.equal(store.consume(capability), false);
});

test("store: expiry boundary is exclusive (expiresAt itself is already expired)", () => {
  const clock = createClock();
  const store = createHostCapabilityStore({
    now: clock.now,
    ttlMs: 1_000,
    createCapability: sequentialCapabilities(),
  });
  const early = store.issue();
  const late = store.issue();
  clock.set(early.expiresAt - 1);
  assert.equal(store.consume(early.capability), true);
  clock.set(late.expiresAt);
  assert.equal(store.consume(late.capability), false);
});

test("store: an expired ticket is rejected and deleted (delete-then-validate)", () => {
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now, ttlMs: 1_000 });
  const { capability } = store.issue();
  clock.advance(1_000);
  assert.equal(store.consume(capability), false);
  // 回拨时钟后若 ticket 仍在内存中就会被接受；实际被拒，证明失败的校验也已消费它。
  clock.set(T0);
  assert.equal(store.consume(capability), false);
});

test("store: missing, unknown and malformed values are rejected without burning a live ticket", () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  const { capability } = store.issue();
  const attempts: Array<string | undefined> = [
    undefined,
    "",
    "   ",
    "unknown-ticket",
    `${capability} `,
    ` ${capability}`,
    `${capability}x`,
    capability.slice(0, -1),
    capability.toUpperCase() === capability ? capability.toLowerCase() : capability.toUpperCase(),
    `${capability},${capability}`,
    "x".repeat(8_192),
  ];
  for (const attempt of attempts) {
    assert.equal(store.consume(attempt), false, `attempt ${JSON.stringify(attempt?.slice(0, 32))}`);
  }
  assert.equal(store.consume(capability), true, "near-miss attempts must not consume the ticket");
});

test("store: consuming any value purges other expired tickets as a side effect", () => {
  const clock = createClock();
  const store = createHostCapabilityStore({
    now: clock.now,
    ttlMs: 1_000,
    createCapability: sequentialCapabilities(),
  });
  const stale = store.issue();
  clock.advance(1_000);
  assert.equal(store.consume("unknown-ticket"), false);
  clock.set(T0);
  assert.equal(
    store.consume(stale.capability),
    false,
    "expired entry was purged on unrelated consume",
  );
});

test("store: tickets are independent and not transferable between stores", () => {
  const clock = createClock();
  const storeA = createHostCapabilityStore({ now: clock.now });
  const storeB = createHostCapabilityStore({ now: clock.now });
  const first = storeA.issue();
  const second = storeA.issue();
  assert.equal(storeB.consume(first.capability), false, "store B never issued this ticket");
  assert.equal(storeA.consume(first.capability), true);
  assert.equal(storeA.consume(second.capability), true, "consuming one ticket leaves others alive");
});

test("store: concurrent consumes of one ticket yield exactly one success", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  const { capability } = store.issue();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => Promise.resolve().then(() => store.consume(capability))),
  );
  assert.equal(results.filter(Boolean).length, 1);
});

test("store: a re-issued duplicate value is still a single-use slot", () => {
  const store = createHostCapabilityStore({
    now: createClock().now,
    createCapability: () => "dup",
  });
  store.issue();
  store.issue();
  assert.equal(store.consume("dup"), true);
  assert.equal(store.consume("dup"), false);
});

// ---------------------------------------------------------------------------
// HTTP 层：真实 createHttpServer 的 /ws/host upgrade
// ---------------------------------------------------------------------------

type UpgradeOutcome = { kind: "open"; socket: WebSocket } | { kind: "rejected"; status: number };

function attemptUpgrade(
  url: string,
  headers: Record<string, string | string[]> = {},
): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, { headers });
    socket.on("open", () => {
      settled = true;
      resolve({ kind: "open", socket });
    });
    socket.on("unexpected-response", (_request, response) => {
      settled = true;
      response.resume();
      resolve({ kind: "rejected", status: response.statusCode ?? 0 });
      socket.terminate();
    });
    socket.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function expectOpen(outcome: Promise<UpgradeOutcome>, message: string): Promise<void> {
  const result = await outcome;
  assert.equal(result.kind, "open", message);
  if (result.kind === "open") await closeSocket(result.socket);
}

async function expectRejected(outcome: Promise<UpgradeOutcome>, message: string): Promise<void> {
  const result = await outcome;
  if (result.kind === "open") await closeSocket(result.socket);
  assert.deepEqual(result, { kind: "rejected", status: 401 }, message);
}

function hostHeaders(capability: string, extra: Record<string, string> = {}) {
  return { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability, ...extra };
}

interface LegacyServer {
  baseHttp: string;
  hostUrl: string;
  wsUrl: string;
}

async function withLegacyServer(
  options: { authToken?: string },
  run: (server: LegacyServer) => Promise<void>,
): Promise<void> {
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    serverId: "legacy-ws-host-ticket-test",
    workspaces: [],
    ...options,
  }) as Server;
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run({
      baseHttp: `http://127.0.0.1:${port}`,
      hostUrl: `ws://127.0.0.1:${port}/ws/host`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

// 与签发端点（Ex2 正在为其加鉴权）的唯一耦合点。
async function issueTicketViaHttp(
  server: LegacyServer,
  headers: Record<string, string> = {},
): Promise<ServerRemoteHostCapability> {
  const response = await fetch(`${server.baseHttp}/api/rpc-host-capability`, {
    method: "POST",
    headers,
  });
  assert.equal(response.status, 200, "ticket issuance must succeed for the consume tests");
  return serverRemoteHostCapabilitySchema.parse(await response.json());
}

test("legacy ws/host: missing, unknown or malformed tickets are rejected (no issuance needed)", async () => {
  await withLegacyServer({}, async ({ hostUrl }) => {
    await expectRejected(attemptUpgrade(hostUrl), "missing header");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders("")), "empty header");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders("unknown-ticket")), "unknown");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders("x".repeat(4_096))), "oversized");
    await expectRejected(attemptUpgrade(`${hostUrl}?capability=abc`), "query string carrier");
  });
});

test("legacy ws/host: valid ticket upgrades; replaying it is rejected with 401", async () => {
  await withLegacyServer({}, async (server) => {
    const { capability } = await issueTicketViaHttp(server);
    await expectOpen(attemptUpgrade(server.hostUrl, hostHeaders(capability)), "first use");
    await expectRejected(attemptUpgrade(server.hostUrl, hostHeaders(capability)), "replay");
  });
});

test("legacy ws/host: near-miss and misplaced tickets do not burn the real one", async () => {
  await withLegacyServer({}, async (server) => {
    const { capability } = await issueTicketViaHttp(server);
    const { hostUrl } = server;
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders(`${capability}x`)), "near miss");
    await expectRejected(
      attemptUpgrade(`${hostUrl}?capability=${encodeURIComponent(capability)}`),
      "query string is not an accepted carrier",
    );
    await expectRejected(
      attemptUpgrade(hostUrl, { authorization: `Bearer ${capability}` }),
      "authorization header is not an accepted carrier",
    );
    await expectRejected(
      attemptUpgrade(hostUrl, { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: [capability, capability] }),
      "duplicated header is joined into an unknown value",
    );
    await expectOpen(attemptUpgrade(hostUrl, hostHeaders(capability)), "ticket still live");
  });
});

test("legacy ws/host: expired ticket is rejected (mocked Date, store built after mock)", async (t) => {
  // createHttpServer 内部 store 使用 `options.now ?? Date.now`，在创建时捕获 Date.now；
  // 因此先 mock Date 再创建 server，才能在不改 src 的情况下推进 TTL。
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  await withLegacyServer({}, async (server) => {
    const fresh = await issueTicketViaHttp(server);
    const stale = await issueTicketViaHttp(server);
    assert.equal(stale.expiresAt, T0 + DEFAULT_HOST_CAPABILITY_TTL_MS);
    t.mock.timers.tick(DEFAULT_HOST_CAPABILITY_TTL_MS - 1);
    await expectOpen(attemptUpgrade(server.hostUrl, hostHeaders(fresh.capability)), "inside TTL");
    t.mock.timers.tick(1);
    await expectRejected(attemptUpgrade(server.hostUrl, hostHeaders(stale.capability)), "expired");
  });
});

test("legacy ws/host: two simultaneous upgrades with one ticket admit exactly one", async () => {
  await withLegacyServer({}, async (server) => {
    const { capability } = await issueTicketViaHttp(server);
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => attemptUpgrade(server.hostUrl, hostHeaders(capability))),
    );
    const opened = outcomes.filter((outcome) => outcome.kind === "open");
    const rejected = outcomes.filter((outcome) => outcome.kind === "rejected");
    await Promise.all(
      opened.map((outcome) => (outcome.kind === "open" ? closeSocket(outcome.socket) : undefined)),
    );
    assert.equal(opened.length, 1);
    assert.deepEqual(
      rejected.map((outcome) => (outcome.kind === "rejected" ? outcome.status : 0)),
      [401, 401, 401],
    );
  });
});

test("legacy ws/host: a non-upgrade request passes the gate and burns the ticket", async () => {
  await withLegacyServer({}, async (server) => {
    for (const method of ["GET", "POST"] as const) {
      const { capability } = await issueTicketViaHttp(server);
      const response = await fetch(`${server.baseHttp}/ws/host`, {
        method,
        headers: hostHeaders(capability),
      });
      await response.body?.cancel();
      assert.equal(response.status, 404, `${method} passes the ticket gate but has no route`);
      await expectRejected(
        attemptUpgrade(server.hostUrl, hostHeaders(capability)),
        `${method} attempt consumed the ticket`,
      );
    }
  });
});

test("legacy ws/host: plain /ws ignores the ticket header and does not consume it", async () => {
  await withLegacyServer({}, async (server) => {
    const { capability } = await issueTicketViaHttp(server);
    await expectOpen(attemptUpgrade(server.wsUrl, hostHeaders(capability)), "plain /ws");
    await expectOpen(
      attemptUpgrade(server.hostUrl, hostHeaders(capability)),
      "ticket survives a /ws connection",
    );
  });
});

test("legacy ws/host: tickets are bound to the issuing server instance", async () => {
  let foreign = "";
  await withLegacyServer({}, async (server) => {
    foreign = (await issueTicketViaHttp(server)).capability;
  });
  await withLegacyServer({}, async ({ hostUrl }) => {
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders(foreign)), "other instance");
  });
});

test("legacy ws/host: lite token gate runs before the ticket is consumed", async () => {
  const authToken = "lite-token-for-test";
  const cookie = `zcode_lite_token=${authToken}`;
  await withLegacyServer({ authToken }, async (server) => {
    const { capability } = await issueTicketViaHttp(server, { cookie });
    await expectRejected(
      attemptUpgrade(server.hostUrl, hostHeaders(capability)),
      "missing lite token is rejected by the token middleware",
    );
    await expectOpen(
      attemptUpgrade(server.hostUrl, hostHeaders(capability, { cookie })),
      "token rejection did not burn the ticket",
    );
    await expectRejected(
      attemptUpgrade(server.hostUrl, hostHeaders(capability, { cookie })),
      "replay with a valid lite token is still rejected",
    );
  });
});
