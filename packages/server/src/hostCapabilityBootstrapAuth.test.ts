import assert from "node:assert/strict";
import { once } from "node:events";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { serverRemoteHostCapabilitySchema, serverRemoteInfoSchema } from "@zcode/shared";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";
import { createHostBootstrapToken } from "./hostBootstrapAuth.js";
import { createHttpServer } from "./http.js";

// M2：旧 server 的 POST /api/rpc-host-capability 只在出示带外 bootstrap 凭据
// （hostBootstrapToken，或未配置时回退为 authToken）时签发 Host ticket；两者都未配置则整条
// 签发路径关闭。浏览器 cookie/query lite token 不能换取 trusted-host ticket。
// 每个拒绝用例都断言注入 store 的 issue() 从未被调用。

interface CountingStore extends HostCapabilityStore {
  readonly issued: () => number;
}

function countingStore(): CountingStore {
  const inner = createHostCapabilityStore();
  let issued = 0;
  return {
    issue() {
      issued += 1;
      return inner.issue();
    },
    consume: (capability) => inner.consume(capability),
    issued: () => issued,
  };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function withLegacy(
  options: { authToken?: string; hostBootstrapToken?: string },
  run: (server: { port: number; store: CountingStore }) => Promise<void>,
): Promise<void> {
  const store = countingStore();
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    serverId: "legacy-host-bootstrap-auth-test",
    workspaces: [],
    hostCapabilityStore: store,
    ...options,
  }) as Server;
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run({ port, store });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const CAPABILITY_PATH = "/api/rpc-host-capability";

function assertRejected(response: RawResponse, status: 401 | 403, message: string): void {
  assert.equal(response.status, status, message);
  assert.doesNotMatch(response.body, /capability"/u, `${message}: no ticket in body`);
}

function assertIssued(response: RawResponse, message: string): void {
  assert.equal(response.status, 200, message);
  assert.equal(response.headers["cache-control"], "no-store", message);
  serverRemoteHostCapabilitySchema.parse(JSON.parse(response.body));
}

test("legacy bootstrap auth: with no credential configured, issuance is closed for everyone", async () => {
  await withLegacy({}, async ({ port, store }) => {
    assertRejected(await send(port, CAPABILITY_PATH), 401, "anonymous");
    assertRejected(
      await send(port, CAPABILITY_PATH, { authorization: `Bearer ${createHostBootstrapToken()}` }),
      401,
      "any bearer value",
    );
    assert.equal(store.issued(), 0);
  });
});

test("legacy bootstrap auth: missing, wrong and garbage credentials are 401", async () => {
  const token = createHostBootstrapToken();
  await withLegacy({ hostBootstrapToken: token }, async ({ port, store }) => {
    const cases: Array<[string, Record<string, string>]> = [
      ["missing", {}],
      ["wrong well-formed secret", { authorization: `Bearer ${createHostBootstrapToken()}` }],
      ["truncated", { authorization: `Bearer ${token.slice(0, -1)}` }],
      ["extended", { authorization: `Bearer ${token}x` }],
      ["garbage", { authorization: "Bearer !!" }],
      ["oversized", { authorization: `Bearer ${"A".repeat(4_096)}` }],
      ["no scheme", { authorization: token }],
      ["wrong scheme", { authorization: `Basic ${token}` }],
    ];
    for (const [label, headers] of cases) {
      assertRejected(await send(port, CAPABILITY_PATH, headers), 401, label);
    }
    assert.equal(store.issued(), 0);
    assertIssued(
      await send(port, CAPABILITY_PATH, { authorization: `Bearer ${token}` }),
      "positive control",
    );
    assert.equal(store.issued(), 1);
  });
});

test("legacy bootstrap auth: authToken maps to the bootstrap credential only as a Bearer header", async () => {
  const authToken = "operator-configured-lite-token";
  await withLegacy({ authToken }, async ({ port, store }) => {
    assertRejected(
      await send(port, CAPABILITY_PATH, { cookie: `zcode_lite_token=${authToken}` }),
      401,
      "browser cookie cannot mint a trusted-host ticket",
    );
    assertRejected(
      await send(port, `${CAPABILITY_PATH}?token=${authToken}`),
      401,
      "query token cannot mint a trusted-host ticket",
    );
    assertRejected(
      await send(port, CAPABILITY_PATH, { authorization: "Bearer not-the-token" }),
      401,
      "wrong bearer",
    );
    assert.equal(store.issued(), 0);
    assertIssued(
      await send(port, CAPABILITY_PATH, { authorization: `Bearer ${authToken}` }),
      "authToken as Bearer",
    );
    // 其他 /api 路径仍由原 lite token middleware 保护，行为不变。
    assert.equal((await send(port, "/api/server-info", {}, "GET")).status, 401);
    assert.equal(
      (await send(port, "/api/server-info", { cookie: `zcode_lite_token=${authToken}` }, "GET"))
        .status,
      200,
    );
  });
});

test("legacy bootstrap auth: dedicated secret and authToken are both accepted when both are set", async () => {
  const authToken = "operator-configured-lite-token";
  const hostBootstrapToken = createHostBootstrapToken();
  await withLegacy({ authToken, hostBootstrapToken }, async ({ port, store }) => {
    assertIssued(
      await send(port, CAPABILITY_PATH, { authorization: `Bearer ${hostBootstrapToken}` }),
      "dedicated secret",
    );
    assertIssued(
      await send(port, CAPABILITY_PATH, { authorization: `Bearer ${authToken}` }),
      "authToken",
    );
    assert.equal(store.issued(), 2);
  });
});

test("legacy bootstrap auth: browser Origin and non-loopback Host on a loopback bind are 403", async () => {
  const token = createHostBootstrapToken();
  await withLegacy({ hostBootstrapToken: token }, async ({ port, store }) => {
    const authorization = `Bearer ${token}`;
    for (const origin of ["https://evil.example", "null"]) {
      assertRejected(
        await send(port, CAPABILITY_PATH, { authorization, origin }),
        403,
        `Origin ${origin}`,
      );
    }
    for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`]) {
      assertRejected(
        await send(port, CAPABILITY_PATH, { authorization, host }),
        403,
        `Host ${host}`,
      );
    }
    assert.equal(store.issued(), 0);
    assertIssued(
      await send(port, CAPABILITY_PATH, { authorization, host: `localhost:${port}` }),
      "localhost authority",
    );
  });
});

test("legacy bootstrap auth: server-info reports authRequired truthfully", async () => {
  for (const options of [{}, { authToken: "operator-configured-lite-token" }]) {
    await withLegacy(options, async ({ port }) => {
      const headers = options.authToken
        ? { cookie: `zcode_lite_token=${options.authToken}` }
        : undefined;
      const response = await send(port, "/api/server-info", headers, "GET");
      assert.equal(response.status, 200);
      assert.equal(serverRemoteInfoSchema.parse(JSON.parse(response.body)).authRequired, true);
    });
  }
});

test("legacy bootstrap auth: injected store is used and default behaviour is unchanged", async () => {
  const token = createHostBootstrapToken();
  await withLegacy({ hostBootstrapToken: token }, async ({ port, store }) => {
    const response = await send(port, CAPABILITY_PATH, { authorization: `Bearer ${token}` });
    assertIssued(response, "issued through the injected store");
    const { capability } = serverRemoteHostCapabilitySchema.parse(JSON.parse(response.body));
    assert.equal(store.issued(), 1);
    assert.equal(store.consume(capability), true, "ticket lives in the injected store");
  });
});
