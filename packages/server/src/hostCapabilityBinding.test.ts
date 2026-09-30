import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER, serverRemoteHostCapabilitySchema } from "@zcode/shared";
import { WebSocket } from "ws";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";
import { createHttpServer } from "./http.js";

// Legacy server 侧的 Host ticket ↔ bootstrap 凭据绑定（docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md）。
// 与 Server Core 使用同一个 @zcode/shared/node 实现；这里另外覆盖 legacy 独有的
// “authToken 兼作 bootstrap 凭据”路径：authToken 轮换后，用旧 authToken 换到的 ticket 失效。

type UpgradeOutcome = { kind: "open"; socket: WebSocket } | { kind: "rejected"; status: number };

const SECRET_A = "legacy-binding-bootstrap-secret-A-000000000";
const SECRET_B = "legacy-binding-bootstrap-secret-B-000000000";
const AUTH_OLD = "legacy-binding-auth-token-old";
const AUTH_NEW = "legacy-binding-auth-token-new";

interface Legacy {
  port: number;
  /** `/ws/host` URL; carries `?token=` when the server has an authToken (lite token middleware). */
  hostUrl: string;
  close(): Promise<void>;
}

async function startLegacy(
  store: unknown,
  options: { hostBootstrapToken?: string; authToken?: string },
): Promise<Legacy> {
  const server = createHttpServer(new ServiceCollection(), 0, {
    host: "127.0.0.1",
    serverId: "legacy-ws-host-binding-test",
    workspaces: [],
    hostCapabilityStore: store as HostCapabilityStore,
    ...options,
  }) as Server;
  if (!server.listening) await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const query = options.authToken ? `?token=${encodeURIComponent(options.authToken)}` : "";
  return {
    port,
    hostUrl: `ws://127.0.0.1:${port}/ws/host${query}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function withLegacy<const P extends ReadonlyArray<Promise<Legacy>>>(
  servers: P,
  run: (servers: { -readonly [K in keyof P]: Legacy }) => Promise<void>,
): Promise<void> {
  const started = await Promise.all(servers);
  try {
    await run(started as { -readonly [K in keyof P]: Legacy });
  } finally {
    await Promise.all(started.map((server) => server.close()));
  }
}

async function issueViaHttp(server: Legacy, credential: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/rpc-host-capability`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}` },
  });
  assert.equal(response.status, 200, "issuance with a configured credential must succeed");
  return serverRemoteHostCapabilitySchema.parse(await response.json()).capability;
}

function attemptUpgrade(url: string, capability: string): Promise<UpgradeOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(url, {
      headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability },
    });
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

async function expectRejected(outcome: Promise<UpgradeOutcome>, message: string): Promise<void> {
  const result = await outcome;
  if (result.kind === "open") result.socket.terminate();
  assert.deepEqual(result, { kind: "rejected", status: 401 }, message);
}

async function plainGetStatus(server: Legacy, capability: string): Promise<number> {
  const response = await fetch(server.hostUrl.replace(/^ws:/u, "http:"), {
    headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability },
  });
  await response.arrayBuffer();
  return response.status;
}

test("legacy binding: a ticket issued under one bootstrap secret is rejected where another is current, without burning it", async () => {
  const store = createHostCapabilityStore();
  await withLegacy(
    [
      startLegacy(store, { hostBootstrapToken: SECRET_A }),
      startLegacy(store, { hostBootstrapToken: SECRET_B }),
    ],
    async ([issuer, rotated]) => {
      const capability = await issueViaHttp(issuer, SECRET_A);
      assert.equal(await plainGetStatus(rotated, capability), 401, "binding checked before 426");
      await expectRejected(attemptUpgrade(rotated.hostUrl, capability), "foreign credential");
      await expectOpen(attemptUpgrade(issuer.hostUrl, capability), "rejection did not burn it");
      await expectRejected(attemptUpgrade(issuer.hostUrl, capability), "single use preserved");
    },
  );
});

test("legacy binding: tickets obtained with a rotated-out authToken are rejected; the surviving credential still works", async () => {
  const store = createHostCapabilityStore();
  await withLegacy(
    [
      startLegacy(store, { hostBootstrapToken: SECRET_A, authToken: AUTH_OLD }),
      startLegacy(store, { hostBootstrapToken: SECRET_A, authToken: AUTH_NEW }),
    ],
    async ([before, after]) => {
      const viaOldAuthToken = await issueViaHttp(before, AUTH_OLD);
      const viaBootstrapSecret = await issueViaHttp(before, SECRET_A);
      await expectRejected(
        attemptUpgrade(after.hostUrl, viaOldAuthToken),
        "rotated-out credential",
      );
      await expectOpen(
        attemptUpgrade(after.hostUrl, viaBootstrapSecret),
        "credential still current",
      );
      await expectOpen(attemptUpgrade(before.hostUrl, viaOldAuthToken), "still current at issuer");
    },
  );
});

test("legacy binding: issuance records the fingerprint of the presented credential, never the raw secret", async () => {
  const inner = createHostCapabilityStore();
  const recorded: unknown[] = [];
  const spy = {
    bindsCredential: true,
    issue: (...args: unknown[]) => {
      recorded.push(args[0]);
      return Reflect.apply(inner.issue, inner, args) as ReturnType<HostCapabilityStore["issue"]>;
    },
    consume: (...args: unknown[]) => Reflect.apply(inner.consume, inner, args) as boolean,
    peek: (...args: unknown[]) => Reflect.apply(inner.peek ?? (() => true), inner, args) as boolean,
  };
  await withLegacy(
    [startLegacy(spy, { hostBootstrapToken: SECRET_A, authToken: AUTH_OLD })],
    async ([server]) => {
      const capability = await issueViaHttp(server, SECRET_A);
      await issueViaHttp(server, AUTH_OLD);
      await issueViaHttp(server, SECRET_A);
      assert.equal(recorded.length, 3);
      const [viaSecret, viaAuth, viaSecretAgain] = recorded as Array<{
        credentialFingerprint?: unknown;
        generation?: unknown;
      }>;
      assert.equal(typeof viaSecret?.credentialFingerprint, "string", "fingerprint recorded");
      assert.equal(viaSecret?.generation, undefined, "legacy server has no Core generation");
      assert.deepEqual(viaSecretAgain, viaSecret, "deterministic per credential");
      assert.notDeepEqual(viaAuth, viaSecret, "bound to the credential actually presented");
      const serialized = JSON.stringify(recorded);
      assert.equal(serialized.includes(SECRET_A) || serialized.includes(AUTH_OLD), false);
      await expectOpen(attemptUpgrade(server.hostUrl, capability), "bound ticket usable at issuer");
    },
  );
});

test("legacy binding: an injected store without binding support keeps working at its issuer and fails closed elsewhere", async () => {
  const inner = createHostCapabilityStore();
  const store = {
    issue: () => inner.issue(),
    consume: (capability?: string) => inner.consume(capability),
  };
  await withLegacy(
    [
      startLegacy(store, { hostBootstrapToken: SECRET_A }),
      startLegacy(store, { hostBootstrapToken: SECRET_B }),
    ],
    async ([issuer, other]) => {
      const capability = await issueViaHttp(issuer, SECRET_A);
      await expectRejected(
        attemptUpgrade(other.hostUrl, capability),
        "issued under another secret",
      );
      await expectOpen(attemptUpgrade(issuer.hostUrl, capability), "own ticket, not burned");
      await expectRejected(
        attemptUpgrade(issuer.hostUrl, store.issue().capability),
        "binding cannot be proven for a ticket the server did not issue: fail closed",
      );
    },
  );
});

test("legacy binding: without any bootstrap credential nothing is bound and in-process tickets work (control)", async () => {
  const store = createHostCapabilityStore();
  await withLegacy([startLegacy(store, {})], async ([server]) => {
    await expectOpen(attemptUpgrade(server.hostUrl, store.issue().capability), "unbound ticket");
  });
});
