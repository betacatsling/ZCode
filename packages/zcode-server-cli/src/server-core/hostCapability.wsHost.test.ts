import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER, serverRemoteHostCapabilitySchema } from "@zcode/shared";
import { WebSocket } from "ws";
import {
  DEFAULT_HOST_CAPABILITY_TTL_MS,
  createHostCapabilityStore,
  type HostCapabilityStore,
} from "./hostCapability.js";
import { createCoreHttpServer } from "./http.js";

// `/ws/host` 一次性 ticket 的消费、重放与过期合同。
// ticket 一律通过注入的 HostCapabilityStore 直接 issue，不经过 `/api/rpc-host-capability`，
// 这样签发端点后续增加鉴权（Ex2）不会影响这里对消费路径的断言。

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

function hostHeaders(capability: string): Record<string, string> {
  return { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability };
}

async function withCoreServer(
  store: HostCapabilityStore,
  run: (server: { baseHttp: string; hostUrl: string; wsUrl: string }) => Promise<void>,
): Promise<void> {
  const server = await createCoreHttpServer(new ServiceCollection(), {
    host: "127.0.0.1",
    port: 0,
    serverId: "ws-host-ticket-test",
    hostCapabilityStore: store,
  });
  try {
    await run({
      baseHttp: `http://127.0.0.1:${server.port}`,
      hostUrl: `ws://127.0.0.1:${server.port}/ws/host`,
      wsUrl: `ws://127.0.0.1:${server.port}/ws`,
    });
  } finally {
    await server.close();
  }
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

// ---------------------------------------------------------------------------
// Store 层：/ws/host middleware 唯一调用的 consume() 语义
// ---------------------------------------------------------------------------

test("store: issue returns a schema-valid ticket that expires after the default TTL", () => {
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now });
  const issued = store.issue();
  assert.deepEqual(serverRemoteHostCapabilitySchema.parse(issued), issued);
  assert.equal(issued.expiresAt, T0 + DEFAULT_HOST_CAPABILITY_TTL_MS);
  assert.equal(DEFAULT_HOST_CAPABILITY_TTL_MS, 30_000);
  // 默认生成器是 32 字节 base64url，不能与其他签发撞值。
  assert.match(issued.capability, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(store.issue().capability, issued.capability);
});

test("store: a valid ticket is consumed exactly once; replay is rejected", () => {
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now });
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
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now });
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
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now, createCapability: () => "dup" });
  store.issue();
  store.issue();
  assert.equal(store.consume("dup"), true);
  assert.equal(store.consume("dup"), false);
});

// ---------------------------------------------------------------------------
// HTTP 层：createCoreHttpServer 的 /ws/host upgrade（注入 store，不走签发端点）
// ---------------------------------------------------------------------------

test("ws/host: valid ticket upgrades; replaying it is rejected with 401", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability } = store.issue();
    await expectOpen(attemptUpgrade(hostUrl, hostHeaders(capability)), "first use upgrades");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders(capability)), "replay is rejected");
  });
});

test("ws/host: expired ticket is rejected, and stays rejected after the clock rewinds", async () => {
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now, ttlMs: 5_000 });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability, expiresAt } = store.issue();
    clock.set(expiresAt);
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders(capability)), "expired");
    clock.set(T0);
    await expectRejected(
      attemptUpgrade(hostUrl, hostHeaders(capability)),
      "expired attempt already consumed the ticket",
    );
  });
});

test("ws/host: ticket just inside its TTL still upgrades", async () => {
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now, ttlMs: 5_000 });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability, expiresAt } = store.issue();
    clock.set(expiresAt - 1);
    await expectOpen(attemptUpgrade(hostUrl, hostHeaders(capability)), "inside TTL");
  });
});

test("ws/host: missing, unknown, malformed or misplaced tickets are rejected", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability } = store.issue();
    await expectRejected(attemptUpgrade(hostUrl), "missing header");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders("")), "empty header");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders("unknown-ticket")), "unknown");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders(`${capability}x`)), "near miss");
    await expectRejected(attemptUpgrade(hostUrl, hostHeaders("x".repeat(4_096))), "oversized");
    await expectRejected(
      attemptUpgrade(`${hostUrl}?capability=${encodeURIComponent(capability)}`),
      "query string is not an accepted carrier",
    );
    await expectRejected(
      attemptUpgrade(hostUrl, { authorization: `Bearer ${capability}` }),
      "authorization header is not an accepted carrier",
    );
    // 重复 header 会被 Node 以 ", " 合并成一个未知值，而不是取第一个。
    await expectRejected(
      attemptUpgrade(hostUrl, { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: [capability, capability] }),
      "duplicated header",
    );
    await expectOpen(
      attemptUpgrade(hostUrl, hostHeaders(capability)),
      "none of the rejected attempts consumed the live ticket",
    );
  });
});

test("ws/host: two simultaneous upgrades with one ticket admit exactly one", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability } = store.issue();
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, () => attemptUpgrade(hostUrl, hostHeaders(capability))),
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
// Consume-on-upgrade：ticket 只在 WebSocket 握手真正被接受时消费（见
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

test("ws/host: plain GET/POST with a valid ticket get 426 and do not burn it", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ baseHttp, hostUrl }) => {
    const { capability } = store.issue();
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

test("ws/host: an Upgrade header without Connection: Upgrade gets 426 and does not burn the ticket", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability } = store.issue();
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

test("ws/host: handshakes rejected by the WebSocket layer do not burn the ticket", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability } = store.issue();
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

test("ws/host: upgrades to the wrong path with the ticket do not burn it", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability } = store.issue();
    for (const path of ["/ws/host/", "/ws/host/extra", "/WS/host", "/ws/hostx"]) {
      const outcome = await attemptUpgrade(new URL(path, hostUrl).href, hostHeaders(capability));
      if (outcome.kind === "open") await closeSocket(outcome.socket);
      assert.equal(outcome.kind, "rejected", `${path} does not open a Host channel`);
    }
    await expectOpen(attemptUpgrade(hostUrl, hostHeaders(capability)), "ticket is still live");
  });
});

test("ws/host: an invalid ticket is refused before any upgrade and does not affect a live one", async () => {
  const clock = createClock();
  const store = createHostCapabilityStore({ now: clock.now, ttlMs: 5_000 });
  await withCoreServer(store, async ({ baseHttp, hostUrl }) => {
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

test("ws/host: after a failed handshake, concurrent upgrades with the same ticket still admit exactly one", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl }) => {
    const { capability } = store.issue();
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

test("ws/host: plain /ws ignores the ticket header and does not consume it", async () => {
  const store = createHostCapabilityStore({ now: createClock().now });
  await withCoreServer(store, async ({ hostUrl, wsUrl }) => {
    const { capability } = store.issue();
    await expectOpen(attemptUpgrade(wsUrl, hostHeaders(capability)), "plain /ws still upgrades");
    await expectOpen(
      attemptUpgrade(hostUrl, hostHeaders(capability)),
      "ticket survives a /ws connection",
    );
  });
});

test("ws/host: a ticket issued by another server instance is rejected", async () => {
  const clock = createClock();
  const issuingStore = createHostCapabilityStore({ now: clock.now });
  const otherStore = createHostCapabilityStore({ now: clock.now });
  const { capability } = issuingStore.issue();
  await withCoreServer(otherStore, async ({ hostUrl }) => {
    await expectRejected(
      attemptUpgrade(hostUrl, hostHeaders(capability)),
      "tickets are bound to the issuing server's in-memory store",
    );
  });
  assert.equal(issuingStore.consume(capability), true, "the foreign attempt did not burn it");
});
