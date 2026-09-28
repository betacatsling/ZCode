import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { conversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { createAgentHostConversationBridge } from "../../services/src/agent-host/conversationBridge.js";
import { HarnessRegistry } from "../../services/src/agent-host/harnessRegistry.js";
import { AgentHostTargetService } from "../../services/src/agent-host/targetService.js";
import { createAgentHostConversationTransport } from "../src/v4/agentHostConversationTransport.js";
import {
  createClient,
  interactionEvent,
  ReusedRpcApprovalHarness,
  waitForInteraction,
} from "./fixtures/codexApprovalTurnCorrelationHarness.js";

test("V4 bridge rejects an old reused Codex RPC approval ID and preserves a single resolution winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-approval-turn-correlation-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "codex-approval-correlation",
    execution: {
      targetId: "local",
      workspaceIdentity: "approval-workspace",
      worktreePath: worktree,
    },
    harness: { id: "codex-correlation-fixture", adapterVersion: "0.157.1-test" },
    modelBinding: {
      kind: "host-managed" as const,
      selection: { providerId: "fake-provider", modelId: "fake-model" },
    },
  };
  const harness = new ReusedRpcApprovalHarness();
  const registry = new HarnessRegistry();
  registry.register(harness);
  const target = new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog: { fingerprint: "approval-fixture-v1", validateSelection: () => ({ ok: true }) },
    registry,
    authorizeWorktree: async () => true,
  });
  const bridge = createAgentHostConversationBridge(target);
  const transport = createAgentHostConversationTransport(createClient(target, bridge), {
    spec,
    clientMode: "desktop-continuous",
    runtimePolicy: "start-if-needed",
  });
  let targetClosed = false;
  try {
    await bridge.createExternalSession({ spec });
    const subscription = await transport.subscribe({
      topic: conversationTopic(spec.hostSessionId),
    });
    transport.activate(subscription.ack.subscriptionId);

    const firstWait = interactionEvent(target, spec.hostSessionId);
    const firstSend = await transport.sendCommand({
      commandId: "turn-one",
      clientId: "fixture-client",
      sessionId: spec.hostSessionId,
      type: "sendText",
      payload: { text: "first approval" },
      issuedAt: Date.now(),
    });
    assert.equal(firstSend.status, "accepted");
    const first = await waitForInteraction(target, spec, subscription.ack.logEpoch, firstWait);
    const oldInteractionId = first.interaction.interactionId;
    assert.match(oldInteractionId, /turn-one/);
    const firstResolution = await transport.sendCommand({
      commandId: "turn-one-deny",
      clientId: "fixture-client",
      sessionId: spec.hostSessionId,
      baseLogEpoch: first.snapshot.logEpoch,
      type: "resolveInteraction",
      payload: { interactionId: oldInteractionId, answer: { action: "decline" } },
      issuedAt: Date.now(),
    });
    assert.equal(firstResolution.status, "accepted");
    await target.waitForIdle(spec);
    assert.equal(harness.respondedRpcIds.length, 1);
    assert.equal(harness.respondedRpcIds[0]?.id, 7);

    const secondWait = interactionEvent(target, spec.hostSessionId);
    const secondSend = await transport.sendCommand({
      commandId: "turn-two",
      clientId: "fixture-client",
      sessionId: spec.hostSessionId,
      type: "sendText",
      payload: { text: "second approval" },
      issuedAt: Date.now(),
    });
    assert.equal(secondSend.status, "accepted");
    const second = await waitForInteraction(target, spec, subscription.ack.logEpoch, secondWait);
    const currentInteractionId = second.interaction.interactionId;
    assert.notEqual(currentInteractionId, oldInteractionId);
    assert.match(currentInteractionId, /turn-two/);

    await assert.rejects(
      transport.sendCommand({
        commandId: "late-old-approval",
        clientId: "fixture-client",
        sessionId: spec.hostSessionId,
        baseLogEpoch: first.snapshot.logEpoch,
        type: "resolveInteraction",
        payload: { interactionId: oldInteractionId, answer: { action: "accept" } },
        issuedAt: Date.now(),
      }),
      /stale-interaction/,
    );
    assert.equal(harness.respondedRpcIds.length, 1);

    const resolutionEntered = harness.holdNextResolution();
    const allow = transport.sendCommand({
      commandId: "turn-two-allow",
      clientId: "fixture-client",
      sessionId: spec.hostSessionId,
      baseLogEpoch: second.snapshot.logEpoch,
      type: "resolveInteraction",
      payload: { interactionId: currentInteractionId, answer: { action: "accept" } },
      issuedAt: Date.now(),
    });
    await resolutionEntered;
    const deny = transport.sendCommand({
      commandId: "turn-two-deny",
      clientId: "fixture-client",
      sessionId: spec.hostSessionId,
      baseLogEpoch: second.snapshot.logEpoch,
      type: "resolveInteraction",
      payload: { interactionId: currentInteractionId, answer: { action: "decline" } },
      issuedAt: Date.now(),
    });
    assert.equal((await deny).status, "rejected");
    harness.releaseHeldResolution();
    assert.equal((await allow).status, "accepted");
    await target.waitForIdle(spec);
    assert.equal(harness.respondedRpcIds.length, 2);
    assert.deepEqual(harness.respondedRpcIds[1], { id: 7, decision: { decision: "accept" } });
    assert.equal((await target.snapshot(spec)).pendingInteractions.length, 0);

    await target.close();
    targetClosed = true;
  } finally {
    harness.releaseHeldResolution();
    transport.dispose();
    bridge.dispose();
    if (!targetClosed) await target.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
