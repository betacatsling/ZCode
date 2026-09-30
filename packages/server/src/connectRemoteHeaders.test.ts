import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { createHttpServer } from "./http.js";

// `POST /api/connect-remote` 会按请求体建立 SSH/WSL/Docker 远程连接（有副作用），仓库内没有任何调用方
// （Web UI 的 connectRemote 直接返回 "not supported"）。它必须挡住 CSRF 与 DNS rebinding
// （docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md "Local endpoints"）：
// - Origin 存在时只接受 http(s)://<Host>（与 legacy /ws 相同）；null、其他站点、其他 loopback 端口 → 403；
// - 监听回环时非回环 Host → 403；
// - 请求体必须声明 application/json → 否则 415。跨站页面不经 CORS 预检只能发 text/plain、
//   application/x-www-form-urlencoded、multipart/form-data；本 server 从不应答预检，所以即使浏览器
//   （或插件）没带 Origin，也送不出 JSON 请求。没有 Origin 的 JSON 请求就是 Node 客户端路径。
// 请求体一律用 `{}`：能通过头部检查的请求在 handler 里被 schema 拒绝（400），不会真的发起远程连接，
// 因而 400 = "到达了 handler"，403/415 = "在 handler 之前被拒绝"。

interface RawResponse {
  status: number;
  body: string;
}

function httpPost(
  hostname: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: hostname,
        port,
        method: "POST",
        path,
        headers: { "Content-Length": String(Buffer.byteLength(body)), ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

async function withLegacy(
  run: (server: { port: number; host: string }) => Promise<void>,
  options: { host?: string; authToken?: string } = {},
): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const server = createHttpServer(new ServiceCollection(), 0, {
    hostBootstrapToken: "legacy-connect-remote-headers-token-00000000",
    ...options,
    host,
  }) as Server;
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run({ port, host });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const JSON_TYPE = { "Content-Type": "application/json" };
// Content types a cross-site page can POST without a CORS preflight (form or no-cors fetch).
const SIMPLE_TYPES = [
  "text/plain",
  "text/plain;charset=UTF-8",
  "application/x-www-form-urlencoded",
  "multipart/form-data; boundary=zcode",
];

function crossSiteOrigins(port: number): string[] {
  return [
    "https://evil.example",
    "null",
    // Another loopback port is cross-origin but *same-site*: SameSite=Lax cookies still ride along.
    `http://127.0.0.1:${port + 1 > 65535 ? port - 1 : port + 1}`,
    `http://localhost:${port + 1 > 65535 ? port - 1 : port + 1}`,
    `http://evil.example:${port}`,
  ];
}

function post(port: number, headers: Record<string, string>, body = "{}") {
  return httpPost("127.0.0.1", port, "/api/connect-remote", headers, body);
}

test("legacy connect-remote: cross-site Origins are refused with 403 before the handler (CSRF)", async () => {
  await withLegacy(async ({ port }) => {
    for (const origin of crossSiteOrigins(port)) {
      for (const type of [...SIMPLE_TYPES, "application/json"]) {
        const response = await post(port, { Origin: origin, "Content-Type": type });
        assert.equal(response.status, 403, `Origin ${origin}, ${type}`);
      }
    }
  });
});

test("legacy connect-remote: a non-loopback Host is refused with 403 when bound to loopback (DNS rebinding)", async () => {
  await withLegacy(async ({ port }) => {
    for (const host of [`evil.example:${port}`, "localhost.evil.example", `10.0.0.5:${port}`]) {
      assert.equal((await post(port, { Host: host, ...JSON_TYPE })).status, 403, `Host ${host}`);
    }
    // A rebinding page is "same-origin" with the name it rebound; only the Host check stops it.
    const rebinding = { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` };
    assert.equal((await post(port, { ...rebinding, ...JSON_TYPE })).status, 403, "rebinding pair");
  });
});

test("legacy connect-remote: without application/json the request is refused with 415, Origin or not", async () => {
  await withLegacy(async ({ port }) => {
    for (const type of [...SIMPLE_TYPES, "application/jsonx", "text/json"]) {
      assert.equal((await post(port, { "Content-Type": type })).status, 415, `no Origin, ${type}`);
      const sameOrigin = { Origin: `http://127.0.0.1:${port}`, "Content-Type": type };
      assert.equal((await post(port, sameOrigin)).status, 415, `same-origin, ${type}`);
    }
    assert.equal((await post(port, {})).status, 415, "no Content-Type");
  });
});

test("legacy connect-remote: malformed JSON is a 400, not a 500", async () => {
  await withLegacy(async ({ port }) => {
    const response = await post(port, JSON_TYPE, "{not json");
    assert.equal(response.status, 400);
  });
});

test("legacy connect-remote: with the lite token, a same-site page on another port is still refused", async () => {
  const authToken = "legacy-connect-remote-lite-token";
  await withLegacy(
    async ({ port }) => {
      const cookie = { Cookie: `zcode_lite_token=${authToken}` };
      const otherPort = `http://localhost:${port + 1 > 65535 ? port - 1 : port + 1}`;
      for (const type of ["text/plain", "application/json"]) {
        const response = await post(port, { ...cookie, Origin: otherPort, "Content-Type": type });
        assert.equal(response.status, 403, `cookie + ${otherPort}, ${type}`);
      }
      assert.equal((await post(port, { ...cookie, "Content-Type": "text/plain" })).status, 415);
      // Control: the token still gates everything else.
      assert.equal((await post(port, JSON_TYPE)).status, 401, "no token");
      assert.equal((await post(port, { ...cookie, ...JSON_TYPE })).status, 400, "token, JSON");
    },
    { authToken },
  );
});

test("legacy connect-remote: Node clients, the same-origin page and the Vite dev proxy reach the handler (control)", async () => {
  await withLegacy(async ({ port }) => {
    const allowed: Array<Record<string, string>> = [
      {},
      { Origin: `http://127.0.0.1:${port}` },
      { Host: `localhost:${port}`, Origin: `http://localhost:${port}` },
      { Host: `[::1]:${port}` },
      // packages/web/vite.config.ts proxies /api without changeOrigin: Host and Origin are kept.
      { Host: "localhost:5173", Origin: "http://localhost:5173" },
    ];
    for (const headers of allowed) {
      for (const type of [
        "application/json",
        "application/json; charset=utf-8",
        "Application/JSON",
      ]) {
        const response = await post(port, { ...headers, "Content-Type": type });
        assert.equal(response.status, 400, `${JSON.stringify(headers)}, ${type}`);
        assert.match(response.body, /Invalid request body/u);
      }
    }
  });
});

test(
  "legacy connect-remote: bound to a non-loopback address, Host is not checked but Origin and JSON still are",
  { skip: process.platform !== "linux" && "127.0.0.2 is only routable by default on Linux" },
  async () => {
    await withLegacy(
      async ({ port, host }) => {
        const send = (headers: Record<string, string>) =>
          httpPost(host, port, "/api/connect-remote", headers, "{}");
        assert.equal((await send({ Host: "zcode.lan", ...JSON_TYPE })).status, 400, "any Host");
        const lanPage = { Host: "zcode.lan:1", Origin: "http://zcode.lan:1", ...JSON_TYPE };
        assert.equal((await send(lanPage)).status, 400, "same-origin LAN page");
        const crossSite = { Host: "zcode.lan:1", Origin: "https://evil.example", ...JSON_TYPE };
        assert.equal((await send(crossSite)).status, 403, "cross-site Origin");
        assert.equal((await send({ Host: "zcode.lan", "Content-Type": "text/plain" })).status, 415);
      },
      { host: "127.0.0.2" },
    );
  },
);
