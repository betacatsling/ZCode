/**
 * End to end over the real remote-target path: a real Pi AgentHostTargetService behind
 * createRpcAgentHostService, exposed by the server-cli Core HTTP server on `/ws/host`
 * (bootstrap-authenticated ticket, ChannelServer over a WebSocket), and consumed by the desktop's
 * connectToPersistentTarget → RemoteServiceAccess.agentHostService (ProxyChannel / ChannelClient).
 * A recording TCP proxy sits between client and Core so the test can inspect the actual bytes.
 *
 * Locks that the typed AgentModelFailure survives that path on the send receipt (admission
 * refusal after a 401), the snapshot control.lastError, the conversation snapshot frame and the
 * session.error event, for 401 and non-retryable auth_failed 403; and that no key material
 * (the configured key or the upstream error echo) ever appears on the wire.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentCommandReceiptSchema,
  agentEventSchema,
  agentHostConversationFrameSchema,
  type AgentCommandReceipt,
  type AgentHostConversationFrame,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { commandAckSchema, conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { connectToPersistentTarget } from "../../server/src/remote/persistentTargetClient.js";
import { createCoreHttpServer } from "../../zcode-server-cli/src/server-core/http.js";
import { ServiceCollection } from "../src/collection.js";
import { createRpcAgentHostService } from "../src/agent-host/rpcTargetService.js";
import {
  IAgentHostService,
  type IAgentHostService as AgentHostRemote,
} from "../src/agent-host/serviceContract.js";
import {
  LEAK_MARKER,
  createProviderFailureHost,
  startFailingProvider,
} from "./fixtures/providerFailureHost.js";

const SERVER_ID = "typed-failure-core";

/** Loopback TCP relay that keeps every byte in both directions. */
async function startRecordingProxy(targetPort: number) {
  const toServer: Buffer[] = [];
  const toClient: Buffer[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = connect(targetPort, "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("data", (chunk: Buffer) => {
      toServer.push(chunk);
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      toClient.push(chunk);
      client.write(chunk);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as { port: number }).port,
    serverToClient: () => Buffer.concat(toClient),
    clientToServer: () => Buffer.concat(toServer),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, what: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function send(spec: SessionSpec, turnId: string) {
  return {
    type: "send" as const,
    commandId: `${turnId}-command`,
    hostSessionId: spec.hostSessionId,
    turnId,
    text: `prompt ${turnId}`,
  };
}

/** What the desktop consumer builds from a receipt, plus the typed failure it may carry. */
function toV4Ack(receipt: AgentCommandReceipt, revisionAtDecision: number) {
  return commandAckSchema.parse({
    commandId: receipt.commandId,
    status: receipt.status === "rejected" ? "rejected" : "accepted",
    ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
    ...(receipt.message ? { message: receipt.message } : {}),
    revisionAtDecision,
    ...(receipt.failure ? { failure: receipt.failure } : {}),
  });
}

interface RemoteScenario {
  remote: AgentHostRemote;
  host: Awaited<ReturnType<typeof createProviderFailureHost>>;
  provider: Awaited<ReturnType<typeof startFailingProvider>>;
  proxy: Awaited<ReturnType<typeof startRecordingProxy>>;
  frames: AgentHostConversationFrame[];
}

async function withRemoteTarget(run: (scenario: RemoteScenario) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "zcode-typed-failure-remote-"));
  const provider = await startFailingProvider();
  const host = await createProviderFailureHost(root, provider.origin);
  const exposed = createRpcAgentHostService(host.target, () => true);
  const hostBootstrapToken = randomBytes(32).toString("base64url");
  const core = await createCoreHttpServer(
    new ServiceCollection().register(IAgentHostService, exposed.service),
    { host: "127.0.0.1", port: 0, serverId: SERVER_ID, hostBootstrapToken },
  );
  const proxy = await startRecordingProxy(core.port);
  const connection = await connectToPersistentTarget({
    host: "127.0.0.1",
    port: proxy.port,
    expectedTargetId: SERVER_ID,
    hostBootstrapToken,
  });
  const remote = connection.services.agentHostService;
  // Fail fast (not at the test timeout) if the RPC client never initializes.
  const availability = await Promise.race([
    remote.getAvailability(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
  ]);
  assert.ok(availability, "remote agentHost answered over /ws/host");
  const frames: AgentHostConversationFrame[] = [];
  const listener = remote.onConversationFrame((frame) => frames.push(frame));
  try {
    await run({ remote, host, provider, proxy, frames });
  } finally {
    listener.dispose();
    await connection.disposeAndWait();
    await proxy.close();
    await core.close();
    exposed.dispose();
    await host.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs one failing turn over the wire and returns the typed failure the client observed. */
async function failTurnOverWire(scenario: RemoteScenario, spec: SessionSpec, status: number) {
  const { remote, host, provider, frames } = scenario;
  await remote.create(spec);
  await remote.subscribeConversation({
    spec,
    topic: `conversation/${spec.hostSessionId}`,
    clientMode: "desktop-continuous",
    runtimePolicy: "existing-only",
  });
  provider.state.failWith = status;
  const accepted = agentCommandReceiptSchema.parse(await remote.dispatch(spec, send(spec, "t1")));
  assert.equal(accepted.status, "accepted");
  assert.equal("failure" in accepted, false);
  await host.target.waitForIdle(spec);
  const expected = {
    reason: "auth_failed",
    action: "reconfigure-provider",
    providerId: host.providerId,
    modelId: "failing-model",
    statusCode: status,
    retryable: false,
  };

  // (b) snapshot read over RPC, parsed by the client with the shared V4 schema.
  const snapshot = conversationSnapshotSchema.parse(await remote.snapshot(spec));
  assert.equal(snapshot.control.lastError?.code, "provider-reconfigure-required");
  assert.deepEqual(snapshot.control.lastError?.failure, expected);

  // Same field on the pushed conversation snapshot frame (the desktop's live path).
  const framedSnapshot = (candidate: AgentHostConversationFrame) => {
    const wire = agentHostConversationFrameSchema.parse(candidate) as {
      kind: string;
      frame?: { payload?: { kind?: string; snapshot?: unknown } };
    };
    const payload = wire.kind === "complete" ? wire.frame?.payload : undefined;
    return payload?.kind === "snapshot"
      ? conversationSnapshotSchema.parse(payload.snapshot)
      : undefined;
  };
  const framed = await waitFor(
    () =>
      frames
        .map(framedSnapshot)
        .find((snapshot) => snapshot?.control.lastError?.code === "provider-reconfigure-required"),
    "a conversation snapshot frame with lastError",
  );
  assert.deepEqual(framed.control.lastError?.failure, expected);

  // The canonical event read over RPC keeps it too.
  const errors = (await remote.eventsSince(spec, 0))
    .map((event) => agentEventSchema.parse(event))
    .filter((event) => event.kind === "session.error");
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0]?.kind === "session.error" && errors[0].failure, expected);
  return expected;
}

function assertNoKeyMaterialOnWire(scenario: RemoteScenario) {
  const down = scenario.proxy.serverToClient();
  const up = scenario.proxy.clientToServer();
  // Positive control: the recorder does see the typed failure bytes the server sent.
  assert.ok(down.includes("reconfigure-provider"), "recorder captured the typed failure");
  assert.ok(down.includes(scenario.host.providerId), "recorder captured the providerId");
  assert.equal(down.includes(LEAK_MARKER), false, "no key material server → client");
  assert.equal(up.includes(LEAK_MARKER), false, "no key material client → server");
}

test(
  "401 over /ws/host: lastError, frame and event carry the failure; the next send's rejected receipt and ack do too",
  { timeout: 60_000 },
  async () => {
    await withRemoteTarget(async (scenario) => {
      const { remote, host } = scenario;
      const spec = host.specFor("remote-401");
      await failTurnOverWire(scenario, spec, 401);
      const requestsAfter401 = scenario.provider.state.requests;

      // (a) admission refusal: the typed failure crosses on the receipt and the command query.
      const receipt = agentCommandReceiptSchema.parse(
        await remote.dispatch(spec, send(spec, "t2")),
      );
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.reasonCode, "provider-reconfigure-required");
      const local = await host.target.queryCommand(spec, "t2-command");
      assert.ok(local?.failure, "server-side receipt carries a typed failure");
      assert.deepEqual(receipt.failure, local.failure);
      assert.equal(receipt.failure?.reason, "auth_failed");
      assert.equal(receipt.failure?.action, "reconfigure-provider");
      assert.equal(receipt.failure?.providerId, host.providerId);
      assert.equal(receipt.failure?.retryable, false);
      assert.deepEqual(await remote.queryCommand(spec, "t2-command"), receipt);
      assert.equal(
        scenario.provider.state.requests,
        requestsAfter401,
        "refused before any request",
      );

      // Client-side V4 ack parse keeps it (old ack without failure still parses).
      const revision = conversationSnapshotSchema.parse(await remote.snapshot(spec)).revision;
      assert.deepEqual(toV4Ack(receipt, revision).failure, receipt.failure);
      const { failure: _dropped, ...legacy } = receipt;
      assert.equal("failure" in toV4Ack(legacy, revision), false);

      assertNoKeyMaterialOnWire(scenario);
    });
  },
);

test(
  "non-retryable auth_failed 403 over /ws/host: lastError, frame and event carry statusCode 403; the next send is admitted",
  { timeout: 60_000 },
  async () => {
    await withRemoteTarget(async (scenario) => {
      const { remote, host } = scenario;
      const spec = host.specFor("remote-403");
      const expected = await failTurnOverWire(scenario, spec, 403);

      // 403 never marks the Provider, so there is no admission refusal: the receipt is accepted
      // without failure and the turn reaches the Provider again, failing with the same 403.
      const receipt = agentCommandReceiptSchema.parse(
        await remote.dispatch(spec, send(spec, "t2")),
      );
      assert.equal(receipt.status, "accepted");
      assert.equal("failure" in receipt, false);
      await host.target.waitForIdle(spec);
      const snapshot = conversationSnapshotSchema.parse(await remote.snapshot(spec));
      assert.deepEqual(snapshot.control.lastError?.failure, expected);

      assertNoKeyMaterialOnWire(scenario);
    });
  },
);
