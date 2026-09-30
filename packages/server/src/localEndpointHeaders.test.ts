import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { WebSocket } from "ws";
import { createHttpServer } from "./http.js";

// Legacy server 的 `/ws`、`/ws/remote/:id` 与 `/api/server-info` 不做 token 之外的鉴权，但必须挡住
// 跨站页面与 DNS rebinding（docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md
// "Local endpoints: /ws and /api/server-info"）。真实浏览器客户端只有它自己托管的 Web UI
// （packages/web/src/main.tsx）：同源页面，WebSocket 的 Origin 恰为 http(s)://<Host>；
// Vite dev（packages/web/vite.config.ts）代理保留 Host 与 Origin。Node 客户端不发 Origin。
// 只有监听回环地址时才要求回环 Host（与 /api/rpc-host-capability、/ws/host 相同）。

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

async function withLegacy(
  run: (server: { port: number; base: string }) => Promise<void>,
  options: { host?: string; serverId?: string; name?: string; workspaces?: unknown[] } = {},
): Promise<void> {
  const listenHost = options.host ?? "127.0.0.1";
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: listenHost,
    hostBootstrapToken: "legacy-local-endpoint-headers-token-000000",
    workspaces: [{ path: "/tmp/legacy-headers-workspace" }],
    ...options,
  } as Parameters<typeof createHttpServer>[2]) as Server;
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run({ port, base: `${listenHost}:${port}` });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function crossSiteOrigins(port: number): string[] {
  return [
    "https://evil.example",
    "null",
    `http://127.0.0.1:${port + 1 > 65535 ? port - 1 : port + 1}`,
    `http://evil.example:${port}`,
    `ws://127.0.0.1:${port}`,
  ];
}

test("legacy /ws and /ws/remote: cross-site Origins are refused with 403", async () => {
  await withLegacy(async ({ port, base }) => {
    for (const path of ["/ws", "/ws/remote/unknown-id"]) {
      for (const origin of crossSiteOrigins(port)) {
        await expectForbidden(
          attemptUpgrade(`ws://${base}${path}`, { Origin: origin }),
          `${path} Origin ${origin}`,
        );
      }
    }
  });
});

test("legacy /ws: a non-loopback Host is refused with 403 when bound to loopback (DNS rebinding)", async () => {
  await withLegacy(async ({ port, base }) => {
    for (const host of foreignAuthorities(port)) {
      await expectForbidden(attemptUpgrade(`ws://${base}/ws`, { Host: host }), `Host ${host}`);
    }
    // A rebinding page is "same-origin" with the name it rebound; only the Host check stops it.
    await expectForbidden(
      attemptUpgrade(`ws://${base}/ws`, {
        Host: `evil.example:${port}`,
        Origin: `http://evil.example:${port}`,
      }),
      "rebinding pair",
    );
  });
});

test("legacy server-info: cross-site Origin and non-loopback Host are refused with 403", async () => {
  await withLegacy(async ({ port }) => {
    for (const origin of crossSiteOrigins(port)) {
      const response = await httpGet("127.0.0.1", port, "/api/server-info", { Origin: origin });
      assert.equal(response.status, 403, `Origin ${origin}`);
      assert.doesNotMatch(response.body, /workspaces/u, `Origin ${origin}: no info`);
    }
    for (const host of foreignAuthorities(port)) {
      const response = await httpGet("127.0.0.1", port, "/api/server-info", { Host: host });
      assert.equal(response.status, 403, `Host ${host}`);
    }
  });
});

test("legacy server-info: no server id, machine name or label; workspace path kept for the Web UI", async () => {
  const workspaces = [
    { path: "/tmp/legacy-headers-workspace", label: "Secret label", workspaceIdentity: "wid-1" },
  ];
  const options = { serverId: "legacy-private-host-name", name: "Alice's laptop", workspaces };
  await withLegacy(async ({ port }) => {
    const response = await httpGet("127.0.0.1", port, "/api/server-info");
    assert.equal(response.status, 200);
    const info = JSON.parse(response.body) as Record<string, unknown>;
    const allowed = ["version", "protocolVersion", "authRequired", "capabilities", "workspaces"];
    assert.deepEqual(
      Object.keys(info).filter((key) => !allowed.includes(key)),
      [],
    );
    assert.deepEqual(info["workspaces"], [
      { path: "/tmp/legacy-headers-workspace", workspaceIdentity: "wid-1" },
    ]);
    assert.equal(response.body.includes("legacy-private-host-name"), false);
    assert.equal(response.body.includes("Alice"), false);
  }, options);
  await withLegacy(async ({ port }) => {
    const info = JSON.parse((await httpGet("127.0.0.1", port, "/api/server-info")).body) as {
      serverId?: unknown;
    };
    assert.notEqual(info.serverId, hostname(), "default server id (os.hostname()) not published");
  });
});

test("legacy /ws and server-info: the Web UI's same-origin page, Vite dev proxy and Node clients still work (control)", async () => {
  await withLegacy(async ({ port, base }) => {
    const sameOrigin: Array<Record<string, string>> = [
      { Origin: `http://127.0.0.1:${port}` },
      { Host: `localhost:${port}`, Origin: `http://localhost:${port}` },
      { Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` },
      // Vite dev server (port 5173) proxies /ws and /api without changeOrigin: Host and Origin kept.
      { Host: "localhost:5173", Origin: "http://localhost:5173" },
      {},
    ];
    for (const headers of sameOrigin) {
      const label = JSON.stringify(headers);
      await expectOpen(attemptUpgrade(`ws://${base}/ws`, headers), `/ws ${label}`);
      await expectOpen(attemptUpgrade(`ws://${base}/ws/remote/x`, headers), `/ws/remote ${label}`);
      const response = await httpGet("127.0.0.1", port, "/api/server-info", headers);
      assert.equal(response.status, 200, `server-info ${label}`);
      // packages/web/src/main.tsx and scripts/zcode-distribution-smoke.mjs read workspaces[0].path.
      const info = JSON.parse(response.body) as { workspaces?: Array<{ path?: unknown }> };
      assert.equal(info.workspaces?.[0]?.path, "/tmp/legacy-headers-workspace", label);
    }
  });
});

test(
  "legacy /ws: bound to a non-loopback address, Host is not checked but cross-site Origins still are",
  { skip: process.platform !== "linux" && "127.0.0.2 is only routable by default on Linux" },
  async () => {
    await withLegacy(
      async ({ port, base }) => {
        await expectOpen(attemptUpgrade(`ws://${base}/ws`, { Host: "zcode.lan" }), "any Host");
        await expectOpen(
          attemptUpgrade(`ws://${base}/ws`, { Host: "zcode.lan:1", Origin: "http://zcode.lan:1" }),
          "same-origin LAN page",
        );
        await expectForbidden(
          attemptUpgrade(`ws://${base}/ws`, { Origin: "https://evil.example" }),
          "cross-site Origin",
        );
        const info = await httpGet("127.0.0.2", port, "/api/server-info", { Host: "zcode.lan" });
        assert.equal(info.status, 200);
      },
      { host: "127.0.0.2" },
    );
  },
);
