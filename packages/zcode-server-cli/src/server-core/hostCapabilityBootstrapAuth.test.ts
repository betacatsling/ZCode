import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import {
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
} from "@zcode/shared";
import { WebSocket } from "ws";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";
import {
  createHostBootstrapToken,
  HOST_BOOTSTRAP_TOKEN_PATTERN,
  isLoopbackAuthority,
  verifyHostBootstrapRequest,
} from "./hostBootstrapAuth.js";
import { createCoreHttpServer } from "./http.js";

// M2：POST /api/rpc-host-capability 只把一次性 Host ticket 签发给持有当前 Core 私有
// bootstrap secret 的调用方（docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md）。
// 每个拒绝用例同时断言 store.issue() 从未被调用，证明“拒绝”不是“签发后丢弃”。

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

/** node:http 而非 fetch：需要任意设置 Host/Origin 头来模拟 DNS rebinding 与浏览器请求。 */
function postCapability(port: number, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: "POST", path: "/api/rpc-host-capability", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.once("error", reject);
    req.end();
  });
}

async function withCore(
  run: (core: { port: number; token: string; store: CountingStore }) => Promise<void>,
  token = createHostBootstrapToken(),
): Promise<void> {
  const store = countingStore();
  const server = await createCoreHttpServer(new ServiceCollection(), {
    host: "127.0.0.1",
    port: 0,
    serverId: "host-bootstrap-auth-test",
    hostCapabilityStore: store,
    hostBootstrapToken: token,
  });
  try {
    await run({ port: server.port, token, store });
  } finally {
    await server.close();
  }
}

function assertRejected(response: RawResponse, status: 401 | 403, message: string): void {
  assert.equal(response.status, status, message);
  assert.doesNotMatch(response.body, /capability"/u, `${message}: no ticket in body`);
  assert.equal(response.headers["cache-control"], "no-store", `${message}: not cacheable`);
}

test("core bootstrap auth: missing credential is 401 and never issues a ticket", async () => {
  await withCore(async ({ port, store }) => {
    assertRejected(await postCapability(port), 401, "no Authorization header");
    assertRejected(
      await postCapability(port, { authorization: "" }),
      401,
      "empty Authorization header",
    );
    assert.equal(store.issued(), 0);
  });
});

test("core bootstrap auth: a wrong but well-formed credential is 401", async () => {
  await withCore(async ({ port, store }) => {
    const other = createHostBootstrapToken();
    assertRejected(
      await postCapability(port, { authorization: `Bearer ${other}` }),
      401,
      "another Core's secret",
    );
    assert.equal(store.issued(), 0);
  });
});

test("core bootstrap auth: wrong-length, garbage and mis-carried credentials are 401", async () => {
  await withCore(async ({ port, token, store }) => {
    const cases: Array<[string, Record<string, string>]> = [
      ["truncated secret", { authorization: `Bearer ${token.slice(0, -1)}` }],
      ["extended secret", { authorization: `Bearer ${token}x` }],
      ["short garbage", { authorization: "Bearer x" }],
      ["oversized garbage", { authorization: `Bearer ${"A".repeat(4_096)}` }],
      ["scheme only", { authorization: "Bearer" }],
      ["scheme with blank", { authorization: "Bearer " }],
      ["raw secret without scheme", { authorization: token }],
      ["wrong scheme", { authorization: `Basic ${token}` }],
      ["double space", { authorization: `Bearer  ${token}` }],
      ["trailing data", { authorization: `Bearer ${token} ${token}` }],
      ["secret in ticket header", { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: token }],
      ["secret in cookie", { cookie: `zcode_lite_token=${token}` }],
    ];
    for (const [label, headers] of cases) {
      assertRejected(await postCapability(port, headers), 401, label);
    }
    assert.equal(store.issued(), 0);
  });
});

test("core bootstrap auth: browser Origin and non-loopback Host are rejected even with the valid secret", async () => {
  await withCore(async ({ port, token, store }) => {
    const authorization = `Bearer ${token}`;
    for (const origin of ["https://evil.example", "http://127.0.0.1:3000", "null"]) {
      assertRejected(
        await postCapability(port, { authorization, origin }),
        403,
        `Origin ${origin}`,
      );
    }
    for (const host of [
      `evil.example:${port}`,
      `127.0.0.1.evil.example:${port}`,
      `localhost.evil.example`,
      `10.0.0.5:${port}`,
    ]) {
      assertRejected(await postCapability(port, { authorization, host }), 403, `Host ${host}`);
    }
    assert.equal(store.issued(), 0);
  });
});

test("core bootstrap auth: valid secret issues a usable one-time ticket (positive control)", async () => {
  await withCore(async ({ port, token, store }) => {
    for (const [label, headers] of [
      ["canonical Bearer", { authorization: `Bearer ${token}` }],
      ["case-insensitive scheme", { authorization: `bearer ${token}` }],
      ["localhost authority", { authorization: `Bearer ${token}`, host: `localhost:${port}` }],
      ["IPv6 loopback authority", { authorization: `Bearer ${token}`, host: `[::1]:${port}` }],
    ] as Array<[string, Record<string, string>]>) {
      const response = await postCapability(port, headers);
      assert.equal(response.status, 200, label);
      assert.equal(response.headers["cache-control"], "no-store", label);
      serverRemoteHostCapabilitySchema.parse(JSON.parse(response.body));
    }
    assert.equal(store.issued(), 4);

    const response = await fetch(`http://127.0.0.1:${port}/api/rpc-host-capability`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200, "Node fetch (the real client transport) is accepted");
    const { capability } = serverRemoteHostCapabilitySchema.parse(await response.json());
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/host`, {
      headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close();
    await closed;
  });
});

test("core bootstrap auth: server-info reports authRequired and never leaks the secret", async () => {
  await withCore(async ({ port, token }) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/server-info`);
    const text = await response.text();
    assert.equal(serverRemoteInfoSchema.parse(JSON.parse(text)).authRequired, true);
    assert.equal(text.includes(token), false);
  });
});

test("core bootstrap auth: an omitted secret is generated per server, never fail-open", async () => {
  const store = countingStore();
  const first = await createCoreHttpServer(new ServiceCollection(), { hostCapabilityStore: store });
  const second = await createCoreHttpServer(new ServiceCollection());
  try {
    assert.match(first.hostBootstrapToken, HOST_BOOTSTRAP_TOKEN_PATTERN);
    assert.notEqual(first.hostBootstrapToken, second.hostBootstrapToken);
    assertRejected(await postCapability(first.port), 401, "generated secret still required");
    assertRejected(
      await postCapability(first.port, { authorization: `Bearer ${second.hostBootstrapToken}` }),
      401,
      "secrets are per server instance",
    );
    assert.equal(store.issued(), 0);
    const ok = await postCapability(first.port, {
      authorization: `Bearer ${first.hostBootstrapToken}`,
    });
    assert.equal(ok.status, 200);
  } finally {
    await first.close();
    await second.close();
  }
});

test("core bootstrap auth: weak or malformed configured secrets are refused at startup", async () => {
  for (const weak of ["", "short", "x".repeat(42), `${createHostBootstrapToken()}=`]) {
    await assert.rejects(
      createCoreHttpServer(new ServiceCollection(), { hostBootstrapToken: weak }),
      /32 random bytes/u,
      JSON.stringify(weak),
    );
  }
});

test("core bootstrap auth: verifier and loopback authority parser edge cases", () => {
  const token = createHostBootstrapToken();
  const base = { authorization: `Bearer ${token}`, origin: undefined, host: "127.0.0.1:1" };
  assert.deepEqual(verifyHostBootstrapRequest(base, [token], { requireLoopbackHost: true }), {
    ok: true,
  });
  const notConfigured = verifyHostBootstrapRequest(base, [], { requireLoopbackHost: true });
  assert.equal(notConfigured.ok, false);
  assert.equal(!notConfigured.ok && notConfigured.reason, "not-configured");
  assert.equal(
    verifyHostBootstrapRequest(base, ["", token], { requireLoopbackHost: true }).ok,
    true,
    "empty configured entries are ignored rather than matched",
  );
  for (const ok of ["127.0.0.1", "127.0.0.1:65535", "LOCALHOST:8080", "[::1]", "[::1]:1"]) {
    assert.equal(isLoopbackAuthority(ok), true, ok);
  }
  for (const bad of [
    undefined,
    "",
    "127.0.0.1:65536",
    "127.0.0.2:80",
    "::1",
    "localhost.:80",
    "127.0.0.1@evil.example",
    "evil.example",
  ]) {
    assert.equal(isLoopbackAuthority(bad), false, String(bad));
  }
});
