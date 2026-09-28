import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IAgentHostService } from "@zcode/services";
import { createAgentHostConversationBridge } from "../../services/src/agent-host/conversationBridge.js";
import { HarnessRegistry } from "../../services/src/agent-host/harnessRegistry.js";
import { AgentHostTargetService } from "../../services/src/agent-host/targetService.js";
import { AgentHostConversationFixtureHarness } from "../../services/test/fixtures/agentHostConversationHarness.js";
import { hasOlderRows } from "../src/v4/conversationProjectionStore.js";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import { createAgentHostConversationTransport } from "../src/v4/agentHostConversationTransport.js";

const spec = {
  schemaVersion: 1 as const,
  hostSessionId: "store-integration",
  execution: {
    targetId: "local",
    workspaceIdentity: "store-workspace",
    worktreePath: "/store-worktree",
  },
  harness: { id: "conversation-fixture", adapterVersion: "1.0.0" },
  modelBinding: {
    kind: "host-managed" as const,
    selection: { providerId: "provider-a", modelId: "model-a" },
  },
};

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, "timed out waiting for conversation projection");
}

function createClient(
  target: AgentHostTargetService,
  bridge: ReturnType<typeof createAgentHostConversationBridge>,
): Pick<
  IAgentHostService,
  | "onConversationFrame"
  | "createExternalSession"
  | "subscribeConversation"
  | "resyncConversation"
  | "unsubscribeConversation"
  | "conversationRowsRange"
  | "dispatch"
  | "snapshot"
  | "queryCommand"
> {
  return {
    onConversationFrame: bridge.onFrame,
    createExternalSession: (request) => bridge.createExternalSession(request),
    subscribeConversation: (request) => bridge.subscribeConversation(request),
    resyncConversation: (request) => bridge.resyncConversation(request),
    unsubscribeConversation: (request) => bridge.unsubscribeConversation(request),
    conversationRowsRange: (request) => bridge.conversationRowsRange(request),
    dispatch: (session, command) => target.dispatch(session, command),
    snapshot: (session) => target.snapshot(session),
    queryCommand: (session, commandId) => target.queryCommand(session, commandId),
  };
}

test("AgentHost frames are consumed by desktop/web SessionDataLayers through real projection stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-conversation-store-integration-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const registry = new HarnessRegistry();
  const fixtureHarness = new AgentHostConversationFixtureHarness();
  registry.register(fixtureHarness);
  const target = new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog: {
      fingerprint: "fixture-v1",
      validateSelection: () => ({ ok: true as const }),
    },
    registry,
    authorizeWorktree: async () => true,
  });
  const bridge = createAgentHostConversationBridge(target);
  const hostSpec = { ...spec, execution: { ...spec.execution, worktreePath: worktree } };
  await bridge.createExternalSession({ spec: hostSpec });
  fixtureHarness.seedHistory(hostSpec.hostSessionId, 60);
  await target.snapshot(hostSpec);
  const desktopTransport = createAgentHostConversationTransport(createClient(target, bridge), {
    spec: hostSpec,
    clientMode: "desktop-continuous",
  });
  const webTransport = createAgentHostConversationTransport(createClient(target, bridge), {
    spec: hostSpec,
    clientMode: "web-remote-replayable",
  });
  const desktopKinds: string[] = [];
  const webKinds: string[] = [];
  desktopTransport.onFrame((_frame, context) =>
    desktopKinds.push(context?.deliveryKind ?? "unknown"),
  );
  webTransport.onFrame((_frame, context) => webKinds.push(context?.deliveryKind ?? "unknown"));
  const desktopLayer = new SessionDataLayer({ transport: desktopTransport, keepWarmMs: 0 });
  const webLayer = new SessionDataLayer({ transport: webTransport, keepWarmMs: 0 });
  const desktopLease = desktopLayer.acquire(spec.hostSessionId);
  const webLease = webLayer.acquire(spec.hostSessionId);
  try {
    await waitFor(
      () =>
        desktopLease.store.getState().snapshot !== null &&
        desktopLease.store.getState().status === "live" &&
        webLease.store.getState().snapshot !== null &&
        webLease.store.getState().status === "live",
    );
    assert.deepEqual(desktopKinds, ["initial"]);
    assert.deepEqual(webKinds, ["initial"]);

    const commandId = "store-send-1";
    desktopLease.store.markCommandPending({ commandId, type: "sendText", issuedAt: Date.now() });
    const sendAck = await desktopTransport.sendCommand({
      commandId,
      clientId: "desktop-client",
      sessionId: spec.hostSessionId,
      type: "sendText",
      payload: { text: "fixture prompt", requestedDelivery: "startNow" },
      issuedAt: Date.now(),
    });
    assert.equal(sendAck.status, "accepted");
    desktopLease.store.expectAcceptedInputProjection(commandId);
    await waitFor(
      () =>
        desktopLease.store
          .getState()
          .snapshot?.pendingInteractions.some(
            (interaction) => interaction.interactionId === "approval-store-send-1",
          ) ?? false,
    );
    assert.equal(desktopLease.store.getState().optimisticCommands.length, 0);
    assert.equal(desktopKinds.includes("online"), true);
    assert.equal(webKinds.includes("online"), true);

    const pendingSnapshot = desktopLease.store.getState().snapshot!;
    assert.equal(
      pendingSnapshot.rows.window.some(
        (row) => row.kind === "userInput" && row.text === "fixture prompt",
      ),
      true,
    );
    assert.equal(
      pendingSnapshot.rows.window.some(
        (row) =>
          row.kind === "assistantText" &&
          row.text === "The Pi prepared the requested fixture write and is waiting for approval.",
      ),
      true,
    );
    const resolveAck = await desktopTransport.sendCommand({
      commandId: "store-deny-1",
      clientId: "desktop-client",
      sessionId: spec.hostSessionId,
      baseLogEpoch: pendingSnapshot.logEpoch,
      type: "resolveInteraction",
      payload: { interactionId: "approval-store-send-1", answer: { optionId: "deny" } },
      issuedAt: Date.now(),
    });
    assert.equal(resolveAck.status, "accepted");
    await waitFor(() => {
      const snapshot = desktopLease.store.getState().snapshot;
      return (
        snapshot?.pendingInteractions.length === 0 && snapshot.control.phase === "completedSuccess"
      );
    });
    assert.equal(desktopLease.store.getState().optimisticCommands.length, 0);

    const webSnapshotBeforeRecovery = webLease.store.getState().snapshot!;
    await webTransport.resync({
      subscriptionId: webLease.store.getState().subscriptionId!,
      base: { logEpoch: webSnapshotBeforeRecovery.logEpoch, seq: webSnapshotBeforeRecovery.seq },
    });
    assert.equal(webLease.store.getState().snapshot?.seq, webSnapshotBeforeRecovery.seq);
    assert.equal(webKinds.includes("recovery"), true);

    while (hasOlderRows(desktopLease.store.getState().snapshot)) {
      await desktopLease.store.loadOlder(60);
    }
    const hydrated = desktopLease.store.getState().snapshot!;
    const rowIds = hydrated.rows.window.map((row) => row.rowId);
    assert.equal(rowIds[0], 1);
    assert.equal(rowIds.length, hydrated.rows.totalCount);
    assert.equal(new Set(rowIds).size, rowIds.length);
  } finally {
    desktopLease.release();
    webLease.release();
    desktopLayer.dispose();
    webLayer.dispose();
    desktopTransport.dispose();
    webTransport.dispose();
    bridge.dispose();
    try {
      const snapshot = await target.snapshot(hostSpec);
      const turnId = snapshot.control.activeWorks[0]?.foregroundExecutionId;
      if (turnId) {
        await target.dispatch(hostSpec, {
          type: "cancelTurn",
          commandId: "store-cleanup-cancel",
          hostSessionId: hostSpec.hostSessionId,
          runtimeEpoch: snapshot.logEpoch,
          turnId,
        });
      }
    } catch {
      // Cleanup is best effort after an assertion; the real failure remains visible.
    }
    await target.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping external session A leaves session B on the same target/worktree pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-conversation-owner-isolation-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const registry = new HarnessRegistry();
  registry.register(new AgentHostConversationFixtureHarness());
  const target = new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog: {
      fingerprint: "same-worktree-two-sessions-v1",
      validateSelection: () => ({ ok: true as const }),
    },
    registry,
    authorizeWorktree: async () => true,
  });
  const bridge = createAgentHostConversationBridge(target);
  const specA = {
    ...spec,
    hostSessionId: "pi-session-a",
    execution: { ...spec.execution, worktreePath: worktree },
  };
  const specB = {
    ...spec,
    hostSessionId: "pi-session-b",
    execution: { ...spec.execution, worktreePath: worktree },
  };
  await bridge.createExternalSession({ spec: specA });
  await bridge.createExternalSession({ spec: specB });
  const client = createClient(target, bridge);
  const transportA = createAgentHostConversationTransport(client, {
    spec: specA,
    clientMode: "desktop-continuous",
  });
  const transportB = createAgentHostConversationTransport(client, {
    spec: specB,
    clientMode: "desktop-continuous",
  });
  const layerA = new SessionDataLayer({ transport: transportA, keepWarmMs: 0 });
  const layerB = new SessionDataLayer({ transport: transportB, keepWarmMs: 0 });
  const leaseA = layerA.acquire(specA.hostSessionId);
  const leaseB = layerB.acquire(specB.hostSessionId);

  try {
    await waitFor(
      () =>
        leaseA.store.getState().status === "live" &&
        leaseB.store.getState().status === "live" &&
        leaseA.store.getState().snapshot !== null &&
        leaseB.store.getState().snapshot !== null,
    );
    const sendA = await transportA.sendCommand({
      commandId: "send-pi-a",
      clientId: "desktop-client",
      sessionId: specA.hostSessionId,
      type: "sendText",
      payload: { text: "session A", requestedDelivery: "startNow" },
      issuedAt: Date.now(),
    });
    const sendB = await transportB.sendCommand({
      commandId: "send-pi-b",
      clientId: "desktop-client",
      sessionId: specB.hostSessionId,
      type: "sendText",
      payload: { text: "session B", requestedDelivery: "startNow" },
      issuedAt: Date.now(),
    });
    assert.equal(sendA.status, "accepted");
    assert.equal(sendB.status, "accepted");
    await waitFor(
      () =>
        leaseA.store
          .getState()
          .snapshot?.pendingInteractions.some(
            (interaction) => interaction.interactionId === "approval-send-pi-a",
          ) === true &&
        leaseB.store
          .getState()
          .snapshot?.pendingInteractions.some(
            (interaction) => interaction.interactionId === "approval-send-pi-b",
          ) === true,
    );

    const snapshotA = leaseA.store.getState().snapshot!;
    const snapshotB = leaseB.store.getState().snapshot!;
    const executionA = snapshotA.control.activeWorks[0]?.foregroundExecutionId;
    const executionB = snapshotB.control.activeWorks[0]?.foregroundExecutionId;
    assert.ok(executionA);
    assert.ok(executionB);
    assert.notEqual(executionA, executionB);

    const stopAck = await transportA.sendCommand({
      commandId: "stop-pi-a",
      clientId: "desktop-client",
      sessionId: specA.hostSessionId,
      baseLogEpoch: snapshotA.logEpoch,
      type: "stop",
      payload: { expectedForegroundExecutionId: executionA },
      issuedAt: Date.now(),
    });
    assert.equal(stopAck.status, "accepted");
    await waitFor(() => leaseA.store.getState().snapshot?.pendingInteractions.length === 0);

    const stillRunningB = leaseB.store.getState().snapshot!;
    assert.equal(
      stillRunningB.pendingInteractions.some(
        (interaction) => interaction.interactionId === "approval-send-pi-b",
      ),
      true,
    );
    assert.equal(stillRunningB.control.activeWorks[0]?.foregroundExecutionId, executionB);
    assert.equal(leaseA.store.getState().snapshot?.control.activeWorks.length, 0);
    assert.equal(leaseA.store.getState().snapshot?.control.phase, "completedInterrupted");

    const resolveB = await transportB.sendCommand({
      commandId: "deny-pi-b",
      clientId: "desktop-client",
      sessionId: specB.hostSessionId,
      baseLogEpoch: stillRunningB.logEpoch,
      type: "resolveInteraction",
      payload: { interactionId: "approval-send-pi-b", answer: { optionId: "deny" } },
      issuedAt: Date.now(),
    });
    assert.equal(resolveB.status, "accepted");
    await waitFor(() => leaseB.store.getState().snapshot?.pendingInteractions.length === 0);
  } finally {
    leaseA.release();
    leaseB.release();
    layerA.dispose();
    layerB.dispose();
    transportA.dispose();
    transportB.dispose();
    bridge.dispose();
    await target.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
