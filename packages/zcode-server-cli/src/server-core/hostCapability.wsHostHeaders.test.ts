import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import { WebSocket } from "ws";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";
import { createCoreHttpServer } from "./http.js";

// `/ws/host` 与签发端点 `/api/rpc-host-capability` 使用同一条请求头规则
// （docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md）：任何 Origin → 403（浏览器上下文），
// 非回环 Host → 403（DNS rebinding）。头部拒绝发生在 ticket peek/consume 之前，
// 被拒绝的请求绝不会烧掉 ticket。

type UpgradeOutcome = { kind: "open"; socket: WebSocket } | { kind: "rejected"; status: number };

function attemptUpgrade(
  url: string,
  headers: Record<string, string> = {},
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

async function expectOpen(outcome: Promise<UpgradeOutcome>, message: string): Promise<void> {
  const result = await outcome;
  assert.equal(result.kind, "open", message);
  if (result.kind === "open") {
    const closed = once(result.socket, "close");
    result.socket.close();
    await closed;
  }
}

async function expectStatus(
  outcome: Promise<UpgradeOutcome>,
  status: number,
  message: string,
): Promise<void> {
  const result = await outcome;
  if (result.kind === "open") result.socket.terminate();
  assert.deepEqual(result, { kind: "rejected", status }, message);
}

function ticketHeader(capability: string): Record<string, string> {
  return { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability };
}

const BROWSER_ORIGINS = ["https://evil.example", "http://127.0.0.1:3000", "null"];

function foreignAuthorities(port: number): string[] {
  return [
    `evil.example:${port}`,
    `127.0.0.1.evil.example:${port}`,
    "localhost.evil.example",
    `10.0.0.5:${port}`,
  ];
}

async function withCore(
  run: (core: { port: number; hostUrl: string; store: HostCapabilityStore }) => Promise<void>,
): Promise<void> {
  const store = createHostCapabilityStore();
  const server = await createCoreHttpServer(new ServiceCollection(), {
    host: "127.0.0.1",
    port: 0,
    serverId: "ws-host-headers-test",
    hostCapabilityStore: store,
  });
  try {
    await run({ port: server.port, hostUrl: `ws://127.0.0.1:${server.port}/ws/host`, store });
  } finally {
    await server.close();
  }
}

test("ws/host headers: any Origin header is refused with 403 and does not burn the ticket", async () => {
  await withCore(async ({ hostUrl, store }) => {
    const { capability } = store.issue();
    for (const origin of BROWSER_ORIGINS) {
      await expectStatus(
        attemptUpgrade(hostUrl, { ...ticketHeader(capability), Origin: origin }),
        403,
        `Origin ${origin}`,
      );
    }
    await expectOpen(attemptUpgrade(hostUrl, ticketHeader(capability)), "ticket survived");
    await expectStatus(attemptUpgrade(hostUrl, ticketHeader(capability)), 401, "single use");
  });
});

test("ws/host headers: a non-loopback Host authority is refused with 403 and does not burn the ticket", async () => {
  await withCore(async ({ port, hostUrl, store }) => {
    const { capability } = store.issue();
    for (const host of foreignAuthorities(port)) {
      await expectStatus(
        attemptUpgrade(hostUrl, { ...ticketHeader(capability), Host: host }),
        403,
        `Host ${host}`,
      );
    }
    await expectOpen(attemptUpgrade(hostUrl, ticketHeader(capability)), "ticket survived");
  });
});

test("ws/host headers: header checks run before any ticket or upgrade check", async () => {
  await withCore(async ({ port, hostUrl, store }) => {
    const evilHost = `evil.example:${port}`;
    await expectStatus(
      attemptUpgrade(hostUrl, { Origin: "https://evil.example" }),
      403,
      "no ticket",
    );
    await expectStatus(
      attemptUpgrade(hostUrl, { ...ticketHeader("unknown-ticket"), Host: evilHost }),
      403,
      "unknown ticket",
    );
    const { capability } = store.issue();
    const plain = await fetch(`http://127.0.0.1:${port}/ws/host`, {
      headers: { ...ticketHeader(capability), Origin: "https://evil.example" },
    });
    await plain.arrayBuffer();
    assert.equal(plain.status, 403, "plain GET with Origin: 403 before the 426 upgrade check");
    await expectOpen(attemptUpgrade(hostUrl, ticketHeader(capability)), "ticket survived");
  });
});

test("ws/host headers: loopback authorities without Origin still upgrade (control)", async () => {
  await withCore(async ({ port, hostUrl, store }) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost"]) {
      await expectOpen(
        attemptUpgrade(hostUrl, { ...ticketHeader(store.issue().capability), Host: host }),
        `Host ${host}`,
      );
    }
  });
});
