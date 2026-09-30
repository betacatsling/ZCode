import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { hostname } from "node:os";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { WebSocket } from "ws";
import { createCoreHttpServer } from "./http.js";

// Server Core 的 `/ws` 与 `/api/server-info` 不做 token 鉴权，但必须挡住浏览器与 DNS rebinding
// （docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md "Local endpoints: /ws and /api/server-info"）：
// Core 的真实调用方全是 Node 进程（Desktop Host 的 persistentTargetClient、SSH 连接器、
// verify-remote-ssh.mjs），都不发 Origin；Core 不托管任何网页。因此任何 Origin → 403，
// 非回环 Host → 403；server-info 只返回调用方真正读取的非敏感字段。

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

async function expectForbidden(outcome: Promise<UpgradeOutcome>, message: string): Promise<void> {
  const result = await outcome;
  if (result.kind === "open") result.socket.terminate();
  const observed = result.kind === "open" ? { kind: "open" } : result;
  assert.deepEqual(observed, { kind: "rejected", status: 403 }, message);
}

interface RawResponse {
  status: number;
  body: string;
}

/** node:http rather than fetch: the tests need to set arbitrary Host/Origin headers. */
function httpGet(
  hostname: string,
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: "GET", path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

function foreignAuthorities(port: number): string[] {
  return [
    `evil.example:${port}`,
    `127.0.0.1.evil.example:${port}`,
    "localhost.evil.example",
    `10.0.0.5:${port}`,
  ];
}

async function withCore(
  run: (core: { port: number; wsUrl: string }) => Promise<void>,
  options: { serverId?: string } = {},
): Promise<void> {
  const server = await createCoreHttpServer(new ServiceCollection(), {
    host: "127.0.0.1",
    port: 0,
    ...options,
  });
  try {
    await run({ port: server.port, wsUrl: `ws://127.0.0.1:${server.port}/ws` });
  } finally {
    await server.close();
  }
}

const BROWSER_ORIGINS = ["https://evil.example", "http://127.0.0.1:3000", "null"];

test("core /ws: any Origin is refused with 403 (Core has no browser client)", async () => {
  await withCore(async ({ port, wsUrl }) => {
    for (const origin of [...BROWSER_ORIGINS, `http://127.0.0.1:${port}`]) {
      await expectForbidden(attemptUpgrade(wsUrl, { Origin: origin }), `Origin ${origin}`);
    }
  });
});

test("core /ws: a non-loopback Host authority is refused with 403 (DNS rebinding)", async () => {
  await withCore(async ({ port, wsUrl }) => {
    for (const host of foreignAuthorities(port)) {
      await expectForbidden(attemptUpgrade(wsUrl, { Host: host }), `Host ${host}`);
    }
  });
});

test("core server-info: Origin and non-loopback Host are refused with 403", async () => {
  await withCore(async ({ port }) => {
    for (const origin of [...BROWSER_ORIGINS, `http://127.0.0.1:${port}`]) {
      const response = await httpGet("127.0.0.1", port, "/api/server-info", { Origin: origin });
      assert.equal(response.status, 403, `Origin ${origin}`);
      assert.doesNotMatch(response.body, /serverId|capabilities/u, `Origin ${origin}: no info`);
    }
    for (const host of foreignAuthorities(port)) {
      const response = await httpGet("127.0.0.1", port, "/api/server-info", { Host: host });
      assert.equal(response.status, 403, `Host ${host}`);
    }
  });
});

test("core server-info: only the fields real clients read, never the machine hostname", async () => {
  await withCore(async ({ port }) => {
    const response = await httpGet("127.0.0.1", port, "/api/server-info");
    assert.equal(response.status, 200);
    const info = JSON.parse(response.body) as Record<string, unknown>;
    const allowed = ["serverId", "version", "protocolVersion", "authRequired", "capabilities"];
    assert.deepEqual(
      Object.keys(info).filter((key) => !allowed.includes(key)),
      [],
      "no fields beyond the allow-list (the always-empty workspaces list is gone)",
    );
    assert.notEqual(info["serverId"], hostname(), "embedded Core does not publish os.hostname()");
  });
});

test("core /ws and server-info: real Node clients (no Origin, loopback Host) still work (control)", async () => {
  await withCore(
    async ({ port, wsUrl }) => {
      for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
        await expectOpen(attemptUpgrade(wsUrl, { Host: host }), `Host ${host}`);
        const response = await httpGet("127.0.0.1", port, "/api/server-info", { Host: host });
        assert.equal(response.status, 200, `server-info Host ${host}`);
      }
      // persistentTargetClient reads serverId (target identity) and capabilities.agentHost;
      // verify-remote-ssh.mjs reads capabilities.websocketRpc, serverId and version.
      const info = (await (await fetch(`http://127.0.0.1:${port}/api/server-info`)).json()) as {
        serverId?: unknown;
        version?: unknown;
        capabilities?: { websocketRpc?: unknown; agentHost?: unknown };
      };
      assert.equal(info.serverId, "local:core-headers-test");
      assert.equal(typeof info.version, "string");
      assert.equal(info.capabilities?.websocketRpc, true);
      assert.equal(typeof info.capabilities?.agentHost, "boolean");
    },
    { serverId: "local:core-headers-test" },
  );
});
