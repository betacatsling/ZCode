import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import { projectHostConversation } from "../src/agent-ui-projection/projector.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { createAgentHostConversationBridge } from "../src/agent-host/conversationBridge.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import type { AgentEvent, AgentHostConversationFrame } from "@zcode/shared/agent-host";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(predicate(), true, "timed out waiting for Host conversation frame");
}

test("Host conversation bridge emits initial/online/recovery snapshots and detaches without termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-conversation-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const harness = new MockHarness();
  const registry = new HarnessRegistry();
  registry.register(harness);
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "external-1",
    execution: { targetId: "local", workspaceIdentity: "workspace-1", worktreePath: worktree },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } },
  };
  const target = new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog: { fingerprint: "v1", validateSelection: () => ({ ok: true as const }) },
    registry,
    authorizeWorktree: async () => true,
  });
  const bridge = createAgentHostConversationBridge(target);
  const frames: Array<{ deliveryKind?: unknown; seq?: number }> = [];
  const listener = bridge.onFrame((wire) => {
    if (wire.kind === "complete" && wire.frame && typeof wire.frame === "object") {
      const frame = wire.frame as { payload?: { kind?: string; snapshot?: { seq?: number } } };
      frames.push({ deliveryKind: wire.deliveryKind, seq: frame.payload?.snapshot?.seq });
    }
  });
  try {
    const created = await bridge.createExternalSession({ spec });
    assert.equal(created.locator.hostSessionId, "external-1");
    const subscribed = await bridge.subscribeConversation({
      spec,
      topic: "conversation/external-1",
      clientMode: "desktop-continuous",
      runtimePolicy: "start-if-needed",
    });
    assert.equal(subscribed.ack.mode, "snapshot");
    assert.deepEqual(frames[0], { deliveryKind: "initial", seq: 0 });

    await target.dispatch(spec, {
      type: "send",
      commandId: "send-1",
      hostSessionId: "external-1",
      turnId: "turn-1",
      text: "edit",
    });
    await waitFor(() =>
      frames.some((frame) => frame.deliveryKind === "online" && (frame.seq ?? 0) > 0),
    );
    await harness.waitForInteraction("external-1");
    await target.dispatch(spec, {
      type: "resolveInteraction",
      commandId: "deny-1",
      hostSessionId: "external-1",
      runtimeEpoch: created.snapshot.logEpoch,
      turnId: "turn-1",
      interactionId: "approval-1",
      decision: "deny",
    });
    await target.waitForIdle(spec);

    const beforeRecovery = frames.length;
    await bridge.resyncConversation({
      spec,
      subscriptionId: subscribed.ack.subscriptionId,
      base: { logEpoch: created.snapshot.logEpoch, seq: created.snapshot.seq },
    });
    assert.equal(frames.length > beforeRecovery, true);
    assert.equal(frames.at(-1)?.deliveryKind, "recovery");

    const rows = await bridge.conversationRowsRange({ spec, sessionId: "external-1", limit: 20 });
    assert.equal(rows.rows.length > 0, true);
    await bridge.unsubscribeConversation({ spec, subscriptionId: subscribed.ack.subscriptionId });
    assert.equal((await target.snapshot(spec)).sessionId, "external-1");
  } finally {
    listener.dispose();
    bridge.dispose();
    await target.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("one source bridge keeps a cold subscription across explicit live attach", async () => {
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "handoff",
    execution: { targetId: "local", workspaceIdentity: "workspace", worktreePath: "/handoff" },
    harness: { id: "fixture", adapterVersion: "1.0.0" },
    modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } },
  };
  const runtimeEpoch = "epoch-1";
  const sourceEvents = new Emitter<{ spec: typeof spec; event: AgentEvent }>();
  const liveEvents: AgentEvent[] = [];
  let attached = false;
  const makeSnapshot = () =>
    projectHostConversation({ spec, runtimeEpoch, events: attached ? liveEvents : [] });
  const source = {
    create: async () => makeSnapshot(),
    attach: async () => {
      attached = true;
      return makeSnapshot();
    },
    snapshot: async () => makeSnapshot(),
    conversationRowsRange: async () => {
      const snapshot = makeSnapshot();
      return {
        rows: snapshot.rows.window,
        atSeq: snapshot.seq,
        atRevision: snapshot.revision,
        atLogEpoch: snapshot.logEpoch,
        hasMore: false,
      };
    },
    subscribe: (listener: (value: { spec: typeof spec; event: AgentEvent }) => void) => {
      const subscription = sourceEvents.event(listener);
      return () => subscription.dispose();
    },
  };
  const bridge = createAgentHostConversationBridge(source);
  const deliveries: string[] = [];
  const listener = bridge.onFrame((frame) => deliveries.push(frame.deliveryKind));
  try {
    const subscribed = await bridge.subscribeConversation({
      spec,
      topic: "conversation/handoff",
      clientMode: "desktop-continuous",
      runtimePolicy: "existing-only",
    });
    assert.deepEqual(deliveries, ["initial"]);

    await source.attach();
    const event: AgentEvent = {
      hostSessionId: spec.hostSessionId,
      runtimeEpoch,
      sequence: 1,
      eventId: "turn-started",
      at: 1,
      kind: "turn.started",
      turnId: "turn-1",
    };
    liveEvents.push(event);
    sourceEvents.fire({ spec, event });
    await waitFor(() => deliveries.includes("online"));
    await bridge.resyncConversation({
      spec,
      subscriptionId: subscribed.ack.subscriptionId,
      base: { logEpoch: runtimeEpoch, seq: 1 },
    });
    assert.deepEqual(deliveries, ["initial", "online", "recovery"]);
  } finally {
    listener.dispose();
    bridge.dispose();
  }
});

test("both delivery profiles read terminated history cold without starting an adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-conversation-history-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const registry = new HarnessRegistry();
  const harness = new MockHarness();
  registry.register(harness);
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "history-only",
    execution: {
      targetId: "local",
      workspaceIdentity: "history-workspace",
      worktreePath: worktree,
    },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } },
  };
  const createTarget = (currentRegistry: HarnessRegistry) =>
    new AgentHostTargetService({
      root: join(root, "host"),
      target: {
        id: "local",
        kind: "local",
        platform: process.platform as "darwin" | "linux",
        available: true,
      },
      catalog: { fingerprint: "v1", validateSelection: () => ({ ok: true as const }) },
      registry: currentRegistry,
      authorizeWorktree: async () => true,
    });
  const target = createTarget(registry);
  const firstBridge = createAgentHostConversationBridge(target);
  try {
    await firstBridge.createExternalSession({ spec });
    await target.dispatch(spec, {
      type: "terminateSession",
      commandId: "terminate",
      hostSessionId: spec.hostSessionId,
    });
    await target.close();
    firstBridge.dispose();

    for (const clientMode of ["desktop-continuous", "web-remote-replayable"] as const) {
      const historyTarget = createTarget(new HarnessRegistry());
      const historyBridge = createAgentHostConversationBridge(historyTarget);
      const frames: AgentHostConversationFrame[] = [];
      const listener = historyBridge.onFrame((frame) => frames.push(frame));
      try {
        const result = await historyBridge.subscribeConversation({
          spec,
          topic: `conversation/${spec.hostSessionId}`,
          clientMode,
          runtimePolicy: "existing-only",
        });
        assert.equal(result.ack.mode, "snapshot");
        assert.equal(frames.length, 1);
        assert.equal(frames[0]?.kind, "complete");
      } finally {
        listener.dispose();
        historyBridge.dispose();
        await historyTarget.close();
      }
    }
  } finally {
    await target.close().catch(() => undefined);
    firstBridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
