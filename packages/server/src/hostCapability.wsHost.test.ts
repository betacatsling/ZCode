import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  serverRemoteHostCapabilitySchema,
  type ServerRemoteHostCapability,
} from "@zcode/shared";
import { WebSocket } from "ws";
import {
  DEFAULT_HOST_CAPABILITY_TTL_MS,
  createHostCapabilityStore,
  type HostCapabilityStore,
} from "./hostCapability.js";
import { createHttpServer } from "./http.js";

// 旧 server `/ws/host` 一次性 ticket 的消费、重放与过期合同。
//
// 第一部分直接测试 `/ws/host` middleware 唯一调用的 HostCapabilityStore.consume()，
// ticket 由 store.issue() 构造，不依赖签发端点，对签发鉴权改造（Ex2）无耦合。
//
// 第二部分走真实 createHttpServer，并总是注入 store（`hostCapabilityStore` 选项）：
// 只需要一张 ticket 的消费用例直接 `issueTicket()` 从该 store 取，不经过签发端点；
// 端到端签发→消费、跨实例与 lite token 这几个专门用例仍走真实 `/api/rpc-host-capability`
// （issueTicketViaHttp()）。签发鉴权与绑定本身见 hostCapabilityBootstrapAuth / hostCapabilityBinding 测试。

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
  /** The server's ticket store (injected or created here), for tests that just need a ticket. */
  store: HostCapabilityStore;
}

// Bootstrap credential required by POST /api/rpc-host-capability (Ex2 M2 bootstrap auth).
const LEGACY_TEST_HOST_BOOTSTRAP_TOKEN = "legacy-ws-host-bootstrap-token-for-tests-00";

async function withLegacyServer(
  options: { authToken?: string; hostCapabilityStore?: HostCapabilityStore },
  run: (server: LegacyServer) => Promise<void>,
): Promise<void> {
  // 总是注入 store：只需要一张 ticket 的用例直接从 store 取，不依赖签发端点。
  // 创建发生在调用时，因此 mock 过的 Date.now 会被 store 捕获。
  const store = options.hostCapabilityStore ?? createHostCapabilityStore();
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    serverId: "legacy-ws-host-ticket-test",
    workspaces: [],
    hostBootstrapToken: LEGACY_TEST_HOST_BOOTSTRAP_TOKEN,
    ...options,
    hostCapabilityStore: store,
  }) as Server;
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run({
      baseHttp: `http://127.0.0.1:${port}`,
      hostUrl: `ws://127.0.0.1:${port}/ws/host`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
      store,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

/** Tests about consumption take the ticket straight from the server's store. */
function issueTicket(server: LegacyServer): ServerRemoteHostCapability {
  return server.store.issue();
}

// 真实签发路径：只用于端到端签发→消费、跨实例与 lite token 这几个专门用例。
async function issueTicketViaHttp(
  server: LegacyServer,
  headers: Record<string, string> = {},
): Promise<ServerRemoteHostCapability> {
  const response = await fetch(`${server.baseHttp}/api/rpc-host-capability`, {
    method: "POST",
    headers: { authorization: `Bearer ${LEGACY_TEST_HOST_BOOTSTRAP_TOKEN}`, ...headers },
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
    const { capability } = issueTicket(server);
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
  // withLegacyServer 注入的 store 使用 `options.now ?? Date.now`，在创建时捕获 Date.now；
  // 因此先 mock Date 再创建 server/store，才能推进 TTL。
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  await withLegacyServer({}, async (server) => {
    const fresh = issueTicket(server);
    const stale = issueTicket(server);
    assert.equal(stale.expiresAt, T0 + DEFAULT_HOST_CAPABILITY_TTL_MS);
    t.mock.timers.tick(DEFAULT_HOST_CAPABILITY_TTL_MS - 1);
    await expectOpen(attemptUpgrade(server.hostUrl, hostHeaders(fresh.capability)), "inside TTL");
    t.mock.timers.tick(1);
    await expectRejected(attemptUpgrade(server.hostUrl, hostHeaders(stale.capability)), "expired");
  });
});

test("legacy ws/host: two simultaneous upgrades with one ticket admit exactly one", async () => {
  await withLegacyServer({}, async (server) => {
    const { capability } = issueTicket(server);
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

// ---------------------------------------------------------------------------
// Consume-on-upgrade（legacy server，与 Server Core 同一 shared 实现）：ticket 只在 WebSocket 握手真正被接受时消费（见
// docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md）。未完成 upgrade 的请求不得烧掉它。
// ---------------------------------------------------------------------------

/** 原始 HTTP/1.1 请求：fetch 不能设置 Connection/Upgrade，也无法发出非法握手。返回状态码。 */
async function rawRequest(hostUrl: string, lines: readonly string[]): Promise<number> {
  const url = new URL(hostUrl);
  const raw = connect(Number(url.port), url.hostname);
  await once(raw, "connect");
  let reply = "";
  raw.setEncoding("utf8");
  raw.on("data", (chunk: string) => {
    reply += chunk;
  });
  const closed = once(raw, "close");
  raw.write([...lines, `Host: ${url.host}`, "", ""].join("\r\n"));
  await closed;
  const status = /^HTTP\/1\.1 (\d{3}) /u.exec(reply);
  assert.ok(
    status,
    `server answered with an HTTP status line: ${JSON.stringify(reply.slice(0, 80))}`,
  );
  return Number(status[1]);
}

const WS_KEY = "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==";

test("legacy ws/host: plain GET/POST with a valid ticket get 426 and do not burn it", async () => {
  await withLegacyServer({}, async (server) => {
    const { baseHttp, hostUrl } = server;
    const { capability } = issueTicket(server);
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const response = await fetch(`${baseHttp}/ws/host`, {
        method,
        headers: hostHeaders(capability),
      });
      await response.body?.cancel();
      assert.equal(response.status, 426, `${method} without an upgrade is refused`);
    }
    await expectOpen(attemptUpgrade(hostUrl, hostHeaders(capability)), "ticket is still live");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders(capability)), "then single-use");
  });
});

test("legacy ws/host: an Upgrade header without Connection: Upgrade gets 426 and does not burn the ticket", async () => {
  await withLegacyServer({}, async (server) => {
    const { hostUrl } = server;
    const { capability } = issueTicket(server);
    // Node 只在 Connection: Upgrade 时走 'upgrade' 事件；否则这是普通请求，永远不会握手。
    const status = await rawRequest(hostUrl, [
      "GET /ws/host HTTP/1.1",
      "Connection: close",
      "Upgrade: websocket",
      WS_KEY,
      "Sec-WebSocket-Version: 13",
      `${ZCODE_RPC_HOST_CAPABILITY_HEADER}: ${capability}`,
    ]);
    assert.equal(status, 426);
    await expectOpen(attemptUpgrade(hostUrl, hostHeaders(capability)), "ticket is still live");
  });
});

test("legacy ws/host: handshakes rejected by the WebSocket layer do not burn the ticket", async () => {
  await withLegacyServer({}, async (server) => {
    const { hostUrl } = server;
    const { capability } = issueTicket(server);
    const ticket = `${ZCODE_RPC_HOST_CAPABILITY_HEADER}: ${capability}`;
    const upgrade = ["Connection: Upgrade", "Upgrade: websocket"];
    const rejected: Array<[string, readonly string[], number]> = [
      [
        "unsupported Sec-WebSocket-Version",
        ["GET /ws/host HTTP/1.1", ...upgrade, WS_KEY, "Sec-WebSocket-Version: 7", ticket],
        400,
      ],
      [
        "missing Sec-WebSocket-Key",
        ["GET /ws/host HTTP/1.1", ...upgrade, "Sec-WebSocket-Version: 13", ticket],
        400,
      ],
      [
        "malformed Sec-WebSocket-Key",
        [
          "GET /ws/host HTTP/1.1",
          ...upgrade,
          "Sec-WebSocket-Key: not-a-key",
          "Sec-WebSocket-Version: 13",
          ticket,
        ],
        400,
      ],
      // @hono/node-ws routes every upgrade as GET; ws itself then refuses the method.
      [
        "POST upgrade",
        ["POST /ws/host HTTP/1.1", ...upgrade, WS_KEY, "Sec-WebSocket-Version: 13", ticket],
        405,
      ],
    ];
    for (const [label, lines, expected] of rejected) {
      assert.equal(await rawRequest(hostUrl, lines), expected, label);
    }
    await expectOpen(
      attemptUpgrade(hostUrl, hostHeaders(capability)),
      "no rejected handshake consumed the ticket",
    );
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders(capability)), "then single-use");
  });
});

test("legacy ws/host: upgrades to the wrong path with the ticket do not burn it", async () => {
  await withLegacyServer({}, async (server) => {
    const { hostUrl } = server;
    const { capability } = issueTicket(server);
    for (const path of ["/ws/host/", "/ws/host/extra", "/WS/host", "/ws/hostx"]) {
      const outcome = await attemptUpgrade(new URL(path, hostUrl).href, hostHeaders(capability));
      if (outcome.kind === "open") await closeSocket(outcome.socket);
      assert.equal(outcome.kind, "rejected", `${path} does not open a Host channel`);
    }
    await expectOpen(attemptUpgrade(hostUrl, hostHeaders(capability)), "ticket is still live");
  });
});

test("legacy ws/host: an invalid ticket is refused before any upgrade and does not affect a live one", async () => {
  // 同时验证 legacy server 的 hostCapabilityStore 注入选项仍然生效。
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now, ttlMs: 5_000 });
  await withLegacyServer({ hostCapabilityStore: store }, async ({ baseHttp, hostUrl }) => {
    const live = store.issue();
    const response = await fetch(`${baseHttp}/ws/host`, { headers: hostHeaders("unknown") });
    await response.body?.cancel();
    assert.equal(response.status, 401, "ticket validity is checked before the upgrade check");
    clock.set(live.expiresAt);
    const expired = await fetch(`${baseHttp}/ws/host`, { headers: hostHeaders(live.capability) });
    await expired.body?.cancel();
    assert.equal(expired.status, 401, "expired ticket is refused even without an upgrade");
    clock.set(T0);
    await expectRejected(
      attemptUpgrade(hostUrl, hostHeaders(live.capability)),
      "an expired ticket stays rejected after the clock rewinds",
    );
  });
});

test("legacy ws/host: after a failed handshake, concurrent upgrades with the same ticket still admit exactly one", async () => {
  await withLegacyServer({}, async (server) => {
    const { hostUrl } = server;
    const { capability } = issueTicket(server);
    assert.equal(
      await rawRequest(hostUrl, [
        "GET /ws/host HTTP/1.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        WS_KEY,
        "Sec-WebSocket-Version: 7",
        `${ZCODE_RPC_HOST_CAPABILITY_HEADER}: ${capability}`,
      ]),
      400,
    );
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => attemptUpgrade(hostUrl, hostHeaders(capability))),
    );
    const opened = outcomes.filter((outcome) => outcome.kind === "open");
    await Promise.all(
      opened.map((outcome) => (outcome.kind === "open" ? closeSocket(outcome.socket) : undefined)),
    );
    assert.equal(opened.length, 1, "exactly one upgrade wins the ticket");
    assert.deepEqual(
      outcomes.filter((outcome) => outcome.kind === "rejected"),
      [
        { kind: "rejected", status: 401 },
        { kind: "rejected", status: 401 },
        { kind: "rejected", status: 401 },
      ],
      "losers are refused before 101 Switching Protocols",
    );
  });
});

test("legacy ws/host: plain /ws ignores the ticket header and does not consume it", async () => {
  await withLegacyServer({}, async (server) => {
    const { capability } = issueTicket(server);
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
