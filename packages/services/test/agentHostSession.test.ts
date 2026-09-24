import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

const spec = {
  schemaVersion: 1 as const, hostSessionId: "host-a",
  execution: { targetId: "local-a", workspaceIdentity: "workspace-a", worktreePath: "/tmp/fixture" },
  harness: { id: "mock", adapterVersion: "1.0.0" },
  modelBinding: { kind: "host-managed" as const, selection: { providerId: "provider-a", modelId: "model-a" } },
};
const target = { id: "local-a", kind: "local" as const, platform: "darwin" as const, available: true };
const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

async function fixture(fn: (root: string, registry: HarnessRegistry, mock: MockHarness) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-session-"));
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.register(mock);
  try { await fn(root, registry, mock); } finally { await rm(root, { recursive: true, force: true }); }
}

test("host persists admission and events; detach/reconnect never resends prompt", async () => fixture(async (root, registry, mock) => {
  let host = await SessionHost.create({ root, spec, target, catalog, registry });
  const send = { type: "send", commandId: "cmd-1", hostSessionId: "host-a", turnId: "turn-a", text: "edit" } as const;
  assert.equal((await host.dispatch(send)).status, "accepted");
  await mock.waitForInteraction("host-a");
  assert.equal((await host.dispatch({ type: "detach", commandId: "detach-1", hostSessionId: "host-a" })).status, "completed");
  const epoch = host.binding.runtimeEpoch;
  assert.equal((await host.dispatch({ type: "cancelTurn", commandId: "late", hostSessionId: "host-a", runtimeEpoch: "wrong", turnId: "turn-a" })).status, "rejected");
  assert.equal((await host.dispatch({ type: "resolveInteraction", commandId: "deny", hostSessionId: "host-a", runtimeEpoch: epoch, turnId: "turn-a", interactionId: "approval-1", decision: "deny" })).status, "completed");
  await host.whenIdle();
  assert.equal(host.queryCommand("cmd-1")?.status, "completed");
  const before = host.eventsSince(0);
  assert.equal(before.some((event) => event.kind === "tool.finished"), false);
  assert.equal(host.snapshot().rows.window.some((row) => row.kind === "assistantText" && row.text === "Reading file"), true);
  await host.close();
  host = await SessionHost.open({ root, spec, target, catalog, registry });
  assert.deepEqual(host.eventsSince(0), before);
  assert.equal(host.queryCommand("cmd-1")?.status, "completed");
  assert.equal((await host.dispatch(send)).status, "duplicate");
  assert.equal(host.eventsSince(0).length, before.length);
  await host.close();
}));

test("a replayed backend event is not republished to subscribers", async () => fixture(async (root, registry, mock) => {
  const host = await SessionHost.create({ root, spec, target, catalog, registry });
  const received: string[] = [];
  host.subscribe((event) => received.push(event.eventId));
  await host.dispatch({ type: "send", commandId: "replay-send", hostSessionId: "host-a", turnId: "replay-turn", text: "test" });
  await mock.waitForInteraction("host-a");
  await host.whenEventsSettled();
  const count = received.length;
  mock.emitDuplicate("host-a");
  await host.whenEventsSettled();
  assert.equal(received.length, count);
  assert.equal(host.eventsSince(0).length, count);
  await host.dispatch({ type: "resolveInteraction", commandId: "replay-deny", hostSessionId: "host-a", runtimeEpoch: host.binding.runtimeEpoch, turnId: "replay-turn", interactionId: "approval-1", decision: "deny" });
  await host.whenIdle();
  await host.close();
}));

test("closing an active host does not hang or silently terminate an approval", async () => fixture(async (root, registry, mock) => {
  const host = await SessionHost.create({ root, spec, target, catalog, registry });
  await host.dispatch({ type: "send", commandId: "pending-send", hostSessionId: "host-a", turnId: "pending-turn", text: "test" });
  await mock.waitForInteraction("host-a");
  await assert.rejects(host.close(), /active turn/);
  await host.dispatch({ type: "resolveInteraction", commandId: "pending-deny", hostSessionId: "host-a", runtimeEpoch: host.binding.runtimeEpoch, turnId: "pending-turn", interactionId: "approval-1", decision: "deny" });
  await host.whenIdle();
  await host.close();
}));

test("disallowed route cannot start a backend or silently change model", async () => fixture(async (root, registry, _mock) => {
  await assert.rejects(SessionHost.create({ root, spec, target, catalog: { ...catalog, validateSelection: () => ({ ok: false as const, reason: "model-not-found" }) }, registry }), /model-not-found/);
  await assert.rejects(SessionHost.create({ root, spec: { ...spec, harness: { id: "unknown", adapterVersion: "1" } }, target, catalog, registry }), /unknown harness/);
}));
