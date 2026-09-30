import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { queryObjects } from "node:v8";
import { ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import { createHostCapabilityStore } from "./hostCapability.js";
import { createCoreHttpServer } from "./http.js";

// @hono/node-ws 1.3.x 在路由 handler（upgradeWebSocket）里把 Node IncomingMessage 放进一个强引用 Map
// 作为 "waiter"，只有 ws 发出 "connection"（即握手成功）时才删除。握手在 ws 层被拒绝（方法、
// Sec-WebSocket-Key/Version、子协议、verifyClient、客户端已半关闭）或请求根本没走 upgrade 路径
// （带 Upgrade: websocket 但没有 Connection: Upgrade）时，这个 waiter 连同请求、socket 与 Hono
// context 永远留在 Map 里。
//
// 复现不依赖 GC 时机：v8.queryObjects 在计数前自己做一次同步的 full GC，然后数堆上仍可达的
// IncomingMessage。客户端一律用裸 TCP（不产生客户端 IncomingMessage），只等 socket 拆除这种 I/O；
// 泄漏的请求被 waiter Map 强引用，永远不会回到基线。

const VALID_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const REPEAT = 8;

interface HandshakeSample {
  name: string;
  method?: string;
  key?: string | null;
  version?: string | null;
  protocol?: string;
}

// Rejected by the ws layer after @hono/node-ws has registered its waiter.
const MALFORMED: HandshakeSample[] = [
  { name: "malformed key", key: "nope" },
  { name: "key with one '='", key: "dGhlIHNhbXBsZSBub25jZQ=" },
  { name: "missing key", key: null },
  { name: "version 7", version: "7" },
  { name: "missing version", version: null },
  { name: "POST upgrade", method: "POST" },
  { name: "empty subprotocol", protocol: "chat,,superchat" },
  { name: "duplicate subprotocol", protocol: "chat, chat" },
  { name: "non-token subprotocol", protocol: "a/b" },
  { name: "empty subprotocol header", protocol: "" },
];
const WELL_FORMED: HandshakeSample[] = [
  { name: "plain" },
  { name: "version 8", version: "8" },
  { name: "version 13.0", version: "13.0" },
  { name: "subprotocols", protocol: "chat, superchat" },
];

function handshake(
  port: number,
  path: string,
  sample: HandshakeSample,
  extra: Record<string, string> = {},
): string {
  const method = sample.method ?? "GET";
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
  ];
  const key = sample.key === undefined ? VALID_KEY : sample.key;
  if (key !== null) lines.push(`Sec-WebSocket-Key: ${key}`);
  const version = sample.version === undefined ? "13" : sample.version;
  if (version !== null) lines.push(`Sec-WebSocket-Version: ${version}`);
  if (sample.protocol !== undefined) lines.push(`Sec-WebSocket-Protocol: ${sample.protocol}`);
  if (method !== "GET") lines.push("Content-Length: 0");
  for (const [name, value] of Object.entries(extra)) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** Raw TCP exchange: returns the response status code, then tears the connection down. */
function exchange(port: number, text: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(text));
    let received = "";
    let status = 0;
    const timer = setTimeout(() => socket.destroy(), 2_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!status && received.includes("\r\n")) {
        status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(received)?.[1] ?? -1);
        socket.destroy();
      }
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

function retainedRequests(): number {
  return queryObjects(IncomingMessage, { format: "count" }) as number;
}

/**
 * Baseline once the count stops falling, so garbage from an earlier server (which a full GC may
 * only reclaim after its sockets are torn down) cannot mask a leak by lowering the count later.
 */
async function stableBaseline(): Promise<number> {
  let previous = retainedRequests();
  const deadline = Date.now() + 2_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = retainedRequests();
    if (current >= previous || Date.now() > deadline) return current;
    previous = current;
  }
}

/** Waits (socket teardown only) until the retained-request count is back to `baseline`. */
async function retainedAbove(baseline: number): Promise<number> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const excess = retainedRequests() - baseline;
    if (excess <= 0) return 0;
    if (Date.now() > deadline) return excess;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withCore(run: (port: number, issue: () => string) => Promise<void>): Promise<void> {
  const store = createHostCapabilityStore();
  const server = await createCoreHttpServer(new ServiceCollection(), {
    host: "127.0.0.1",
    port: 0,
    serverId: "ws-upgrade-leak-test",
    hostCapabilityStore: store,
  });
  try {
    await run(server.port, () => store.issue().capability);
  } finally {
    await server.close();
  }
}

test("core /ws: handshakes rejected by the WebSocket layer do not leave retained requests behind", async () => {
  await withCore(async (port) => {
    const baseline = await stableBaseline();
    for (const sample of MALFORMED) {
      for (let i = 0; i < REPEAT; i += 1) {
        const status = await exchange(port, handshake(port, "/ws", sample));
        assert.ok(status === 400 || status === 405, `${sample.name}: status ${status}`);
      }
    }
    assert.equal(await retainedAbove(baseline), 0, "retained requests");
  });
});

test("core /ws: Upgrade: websocket on the plain HTTP path is a 426 and retains nothing", async () => {
  await withCore(async (port) => {
    const plain = [
      "GET /ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: close",
      `Sec-WebSocket-Key: ${VALID_KEY}`,
      "Sec-WebSocket-Version: 13",
    ].join("\r\n");
    const baseline = await stableBaseline();
    const statuses = new Set<number>();
    for (let i = 0; i < REPEAT; i += 1) statuses.add(await exchange(port, `${plain}\r\n\r\n`));
    assert.equal(await retainedAbove(baseline), 0, "retained requests");
    assert.deepEqual([...statuses], [426]);
  });
});

test("core /ws/host: a malformed handshake with a live ticket retains nothing and does not burn it", async () => {
  await withCore(async (port, issue) => {
    const ticket = { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: issue() };
    const baseline = await stableBaseline();
    for (const sample of MALFORMED) {
      const status = await exchange(port, handshake(port, "/ws/host", sample, ticket));
      assert.ok(status === 400 || status === 405, `${sample.name}: status ${status}`);
    }
    assert.equal(await retainedAbove(baseline), 0, "retained requests");
    assert.equal(
      await exchange(port, handshake(port, "/ws/host", { name: "valid" }, ticket)),
      101,
      "ticket opens",
    );
    assert.equal(
      await exchange(port, handshake(port, "/ws/host", { name: "valid" }, ticket)),
      401,
      "then single-use",
    );
  });
});

test("core /ws: accepted upgrades retain nothing once closed (control)", async () => {
  await withCore(async (port) => {
    const baseline = await stableBaseline();
    for (let i = 0; i < REPEAT; i += 1) {
      for (const sample of WELL_FORMED) {
        assert.equal(await exchange(port, handshake(port, "/ws", sample)), 101, sample.name);
      }
    }
    assert.equal(await retainedAbove(baseline), 0, "retained requests");
  });
});
