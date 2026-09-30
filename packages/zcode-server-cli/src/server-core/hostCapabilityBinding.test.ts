import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER, serverRemoteHostCapabilitySchema } from "@zcode/shared";
import { WebSocket } from "ws";
import { createHostBootstrapToken } from "./hostBootstrapAuth.js";
import { createHostCapabilityStore, type HostCapabilityStore } from "./hostCapability.js";
import { createCoreHttpServer } from "./http.js";

// Host ticket 与签发它的 bootstrap 凭据绑定（docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md）：
// 签发时记录凭据指纹（与 Core generation），`/ws/host` 消费时必须等于当前凭据；
// 凭据轮换 / 换代之前签发的 ticket 被拒绝，且拒绝不会烧掉 ticket。
// 两个 Core 共享同一个注入的 store 用来模拟“同一 ticket 被带到轮换之后的 Core”。

type CoreOptions = NonNullable<Parameters<typeof createCoreHttpServer>[1]>;
type UpgradeOutcome = { kind: "open"; socket: WebSocket } | { kind: "rejected"; status: number };

interface Core {
  port: number;
  token: string;
  hostUrl: string;
  close(): Promise<void>;
}

async function startCore(
  store: unknown,
  options: { token?: string; generation?: number } = {},
): Promise<Core> {
  const token = options.token ?? createHostBootstrapToken();
  const server = await createCoreHttpServer(new ServiceCollection(), {
    host: "127.0.0.1",
    port: 0,
    serverId: "ws-host-binding-test",
    hostCapabilityStore: store as HostCapabilityStore,
    hostBootstrapToken: token,
    ...(options.generation === undefined ? {} : { generation: options.generation }),
  } as CoreOptions);
  return {
    port: server.port,
    token,
    hostUrl: `ws://127.0.0.1:${server.port}/ws/host`,
    close: () => server.close(),
  };
}

async function withCores<const P extends ReadonlyArray<Promise<Core>>>(
  cores: P,
  run: (cores: { -readonly [K in keyof P]: Core }) => Promise<void>,
): Promise<void> {
  const started = await Promise.all(cores);
  try {
    await run(started as { -readonly [K in keyof P]: Core });
  } finally {
    await Promise.all(started.map((core) => core.close()));
  }
}

async function issueViaHttp(core: Core): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${core.port}/api/rpc-host-capability`, {
    method: "POST",
    headers: { authorization: `Bearer ${core.token}` },
  });
  assert.equal(response.status, 200, "issuance with the Core's own secret must succeed");
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

async function plainGetStatus(core: Core, capability: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${core.port}/ws/host`, {
    headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability },
  });
  await response.arrayBuffer();
  return response.status;
}

/** Injected store written against the pre-binding interface: no peek, ignores extra arguments. */
function legacyShapedStore(): { issue(): { capability: string }; consume(c?: string): boolean } {
  const inner = createHostCapabilityStore();
  return {
    issue: () => inner.issue(),
    consume: (capability?: string) => inner.consume(capability),
  };
}

test("binding: a ticket issued under one bootstrap secret is rejected by a Core holding another, without burning it", async () => {
  const store = createHostCapabilityStore();
  await withCores([startCore(store), startCore(store)], async ([issuer, rotated]) => {
    const capability = await issueViaHttp(issuer);
    assert.equal(await plainGetStatus(rotated, capability), 401, "binding checked before 426");
    await expectRejected(attemptUpgrade(rotated.hostUrl, capability), "foreign credential");
    await expectRejected(attemptUpgrade(rotated.hostUrl, capability), "still foreign");
    await expectOpen(attemptUpgrade(issuer.hostUrl, capability), "rejection did not burn it");
    await expectRejected(attemptUpgrade(issuer.hostUrl, capability), "single use preserved");
  });
});

test("binding: a ticket from a previous Core generation is rejected even if the secret is reused", async () => {
  const store = createHostCapabilityStore();
  const token = createHostBootstrapToken();
  await withCores(
    [startCore(store, { token, generation: 1 }), startCore(store, { token, generation: 2 })],
    async ([previous, current]) => {
      const stale = await issueViaHttp(previous);
      await expectRejected(attemptUpgrade(current.hostUrl, stale), "previous generation");
      const fresh = await issueViaHttp(current);
      await expectRejected(attemptUpgrade(previous.hostUrl, fresh), "newer generation elsewhere");
      await expectOpen(attemptUpgrade(current.hostUrl, fresh), "current generation");
      await expectOpen(attemptUpgrade(previous.hostUrl, stale), "own generation, not burned");
    },
  );
});

test("binding: issuance records a credential fingerprint and the generation, never the raw secret", async () => {
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
  await withCores([startCore(spy, { generation: 7 })], async ([core]) => {
    const capability = await issueViaHttp(core);
    await issueViaHttp(core);
    assert.equal(recorded.length, 2);
    const [first, second] = recorded as Array<{
      credentialFingerprint?: unknown;
      generation?: unknown;
    }>;
    assert.equal(typeof first?.credentialFingerprint, "string", "fingerprint recorded at issue");
    assert.equal(first?.generation, 7, "Core generation recorded at issue");
    assert.deepEqual(second, first, "fingerprint is deterministic for one credential");
    assert.notEqual(first?.credentialFingerprint, core.token);
    assert.equal(JSON.stringify(recorded).includes(core.token), false, "raw secret never stored");
    await expectOpen(attemptUpgrade(core.hostUrl, capability), "bound ticket usable at issuer");
  });
});

test("binding: an injected store without binding support keeps working at its issuer and fails closed elsewhere", async () => {
  const store = legacyShapedStore();
  await withCores([startCore(store), startCore(store)], async ([issuer, other]) => {
    const capability = await issueViaHttp(issuer);
    await expectRejected(attemptUpgrade(other.hostUrl, capability), "issued under another secret");
    await expectOpen(attemptUpgrade(issuer.hostUrl, capability), "own ticket, not burned");
    await expectRejected(attemptUpgrade(issuer.hostUrl, capability), "single use preserved");
    const unrecorded = store.issue().capability;
    await expectRejected(
      attemptUpgrade(issuer.hostUrl, unrecorded),
      "binding cannot be proven for a ticket the Core did not issue: fail closed",
    );
  });
});

test("binding: in-process unbound issuance on a binding-aware store stays usable (compatibility control)", async () => {
  const store = createHostCapabilityStore();
  await withCores([startCore(store), startCore(store)], async ([first, second]) => {
    await expectOpen(attemptUpgrade(first.hostUrl, store.issue().capability), "unbound at first");
    await expectOpen(attemptUpgrade(second.hostUrl, store.issue().capability), "unbound at second");
    const bound = await issueViaHttp(second);
    await expectOpen(attemptUpgrade(second.hostUrl, bound), "bound at issuer");
  });
});
