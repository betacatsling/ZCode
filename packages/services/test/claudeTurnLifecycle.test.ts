import assert from "node:assert/strict";
import test from "node:test";
import type { BindingPlan } from "@zcode/shared/agent-host";
import type { ModelGateway } from "@zcode/services/model-gateway";
import type { ClaudeSessionRuntime } from "../src/agent-adapters/claude/claudeRuntime.js";
import type { ClaudeStreamProcess } from "../src/agent-adapters/claude/claudeStreamProcess.js";
import {
  ClaudeTurnLifecycle,
  type ClaudeTurnLifecyclePorts,
} from "../src/agent-adapters/claude/claudeTurnLifecycle.js";
import {
  CLAUDE_UNIT,
  claudeUnitPlan,
  claudeUnitRuntime,
  claudeUnitSpec,
  eventKinds,
  fakeClaudeModel,
} from "./fixtures/claudeUnitFixtures.js";

// Unit coverage for the Messages grant lease around one Host turn, over recording gateway,
// process and adapter ports. SessionHost admission itself is not modelled here.

function lifecycle(
  options: { readonly authorized?: () => boolean; readonly renewMs?: number } = {},
) {
  const unit = claudeUnitRuntime();
  const gatewayCalls: string[] = [];
  const portCalls: string[] = [];
  let sendError: Error | undefined;
  const sent: string[] = [];
  let endLeaseThrows = false;
  unit.runtime.gateway = {
    renewGrant: (id: string) => gatewayCalls.push(`renewGrant:${id}`),
    beginTurnLease: (id: string, turn: string) => gatewayCalls.push(`begin:${id}:${turn}`),
    endTurnLease: (id: string, turn: string) => {
      gatewayCalls.push(`end:${id}:${turn}`);
      if (endLeaseThrows) throw new Error("lease already gone");
    },
    renewTurnLease: (id: string, turn: string) => {
      gatewayCalls.push(`renewLease:${id}:${turn}`);
      return { expiresAt: 42 };
    },
    revoke: (id: string) => gatewayCalls.push(`revoke:${id}`),
  } as unknown as ModelGateway;
  const process = {
    isRunning: true,
    sendUserMessage: async (text: string) => {
      sent.push(text);
      if (sendError) throw sendError;
    },
  };
  unit.runtime.process = process as unknown as ClaudeStreamProcess;
  let current: ClaudeSessionRuntime = unit.runtime;
  const ports: ClaudeTurnLifecyclePorts = {
    adapterId: CLAUDE_UNIT.adapterId,
    adapterVersion: CLAUDE_UNIT.adapterVersion,
    hostManagedRoute: CLAUDE_UNIT.route as BindingPlan["route"],
    grantLifetimeMs: 60_000,
    isMessagesSelection: () => true,
    isSelectionAuthorized: () => options.authorized?.() ?? true,
    requireRuntime: () => current,
    replaceIdleBinding: async (runtime, prepared) => {
      portCalls.push(`replace:${prepared.plan.catalogFingerprint}`);
      runtime.plan = prepared.plan;
      runtime.failed = undefined;
      return runtime;
    },
    stopRuntime: async () => {
      portCalls.push("stop");
    },
    markUnknown: (_runtime, turn, message) => {
      portCalls.push(`unknown:${turn.hostTurnId}:${message}`);
    },
  };
  const subject = new ClaudeTurnLifecycle(ports, options.renewMs ?? 60_000);
  const spec = claudeUnitSpec();
  const prepared = (turnId = "turn-1", plan = claudeUnitPlan(spec)) => ({
    plan,
    model: fakeClaudeModel(),
    turnId,
  });
  const command = (turnId = "turn-1") => ({
    type: "send" as const,
    commandId: `command-${turnId}`,
    hostSessionId: spec.hostSessionId,
    turnId,
    text: "hello",
  });
  return {
    ...unit,
    subject,
    spec,
    prepared,
    command,
    gatewayCalls,
    portCalls,
    sent,
    process,
    setCurrent: (runtime: ClaudeSessionRuntime) => (current = runtime),
    failSend: (error: Error) => (sendError = error),
    failEndLease: () => (endLeaseThrows = true),
  };
}

const GRANT = "grant-claude-unit";

test("prepare refuses anything but the exact pinned FakeModel binding", async () => {
  const h = lifecycle();
  const plan = claudeUnitPlan(h.spec);
  const refusals = [
    { ...h.prepared(), turnId: undefined },
    { ...h.prepared(), model: undefined },
    { ...h.prepared(), model: fakeClaudeModel({ reasoningLevel: "high" }) },
    h.prepared("turn-1", { ...plan, route: "native" as BindingPlan["route"] }),
    h.prepared("turn-1", { ...plan, support: { support: "supported" } }),
    h.prepared("turn-1", { ...plan, targetId: "elsewhere" }),
  ];
  for (const prepared of refusals)
    await assert.rejects(h.subject.prepare(h.spec, prepared), /exact pinned Messages FakeModel/);
  const unauthorized = lifecycle({ authorized: () => false });
  await assert.rejects(
    unauthorized.subject.prepare(unauthorized.spec, unauthorized.prepared()),
    /exact pinned Messages FakeModel/,
  );
  assert.deepEqual([h.gatewayCalls, unauthorized.gatewayCalls], [[], []]);
});

test("prepare renews a healthy same-binding grant and begins the turn lease", async () => {
  const h = lifecycle();
  await h.subject.prepare(h.spec, h.prepared());
  assert.deepEqual(h.gatewayCalls, [`renewGrant:${GRANT}`, `begin:${GRANT}:turn-1`]);
  assert.equal(h.runtime.preparedTurnId, "turn-1");
  await assert.rejects(h.subject.prepare(h.spec, h.prepared("turn-2")), /not idle/);
  h.runtime.preparedTurnId = undefined;
  h.runtime.activeTurn = {} as never;
  await assert.rejects(h.subject.prepare(h.spec, h.prepared("turn-2")), /not idle/);
});

test("prepare replaces a failed, exited or rebound runtime instead of renewing it", async () => {
  const arrangements: ((h: ReturnType<typeof lifecycle>) => BindingPlan | undefined)[] = [
    (h) => {
      h.runtime.failed = new Error("x");
      return undefined;
    },
    (h) => {
      h.process.isRunning = false;
      return undefined;
    },
    (h) => ({ ...claudeUnitPlan(h.spec), catalogFingerprint: "catalog-next" }),
  ];
  for (const arrange of arrangements) {
    const h = lifecycle();
    const plan = arrange(h);
    await h.subject.prepare(h.spec, h.prepared("turn-1", plan ?? claudeUnitPlan(h.spec)));
    assert.equal(h.portCalls.length, 1);
    assert.match(h.portCalls[0]!, /^replace:catalog-/);
    assert.deepEqual(h.gatewayCalls, [`begin:${GRANT}:turn-1`]);
  }
});

test("discard ends only the matching prepared lease", () => {
  const h = lifecycle();
  h.subject.discard(h.spec, { plan: claudeUnitPlan(h.spec) });
  h.runtime.preparedTurnId = "turn-1";
  h.subject.discard(h.spec, h.prepared("turn-2"));
  assert.equal(h.runtime.preparedTurnId, "turn-1");
  h.subject.discard(h.spec, h.prepared("turn-1"));
  assert.equal(h.runtime.preparedTurnId, undefined);
  assert.deepEqual(h.gatewayCalls, [`end:${GRANT}:turn-1`]);
});

test("renew extends only the prepared or active turn and revokes a withdrawn selection", () => {
  let authorized = true;
  const h = lifecycle({ authorized: () => authorized });
  assert.throws(() => h.subject.renew(h.spec.hostSessionId, "turn-1"), /does not match/);
  h.runtime.preparedTurnId = "turn-1";
  assert.deepEqual(h.subject.renew(h.spec.hostSessionId, "turn-1"), { expiresAt: 42 });
  authorized = false;
  assert.throws(() => h.subject.renew(h.spec.hostSessionId, "turn-1"), /revoked during the active/);
  assert.match(h.runtime.failed?.message ?? "", /revoked/);
  assert.deepEqual(h.portCalls, [], "a prepared-only turn has no process work to stop");
  h.runtime.activeTurn = { hostTurnId: "turn-1" } as never;
  assert.throws(() => h.subject.renew(h.spec.hostSessionId, "turn-1"), /revoked/);
  assert.deepEqual(h.portCalls, ["stop"]);
  assert.deepEqual(h.gatewayCalls, [
    `renewLease:${GRANT}:turn-1`,
    `revoke:${GRANT}`,
    `revoke:${GRANT}`,
  ]);
});

test("send requires the matching pre-accepted lease and a healthy idle backend", async () => {
  const h = lifecycle();
  await assert.rejects(h.subject.send(h.command()), /no matching pre-accepted turn lease/);
  await assert.rejects(h.subject.send(h.command(), h.prepared()), /no matching pre-accepted/);
  h.runtime.preparedTurnId = "turn-1";
  await assert.rejects(h.subject.send(h.command(), h.prepared("turn-2")), /no matching/);
  for (const [arrange, reason] of [
    [() => (h.runtime.stopping = true), /backend is unavailable/],
    [() => ((h.runtime.stopping = false), (h.process.isRunning = false)), /unavailable/],
    [
      () => ((h.process.isRunning = true), (h.runtime.activeTurn = {} as never)),
      /already executing/,
    ],
  ] as const) {
    arrange();
    await assert.rejects(h.subject.send(h.command(), h.prepared()), reason);
  }
  const foreign = lifecycle();
  foreign.setCurrent({
    ...foreign.runtime,
    binding: { ...foreign.runtime.binding, hostSessionId: "x" },
  });
  await assert.rejects(
    foreign.subject.send(foreign.command(), foreign.prepared()),
    /foreign Claude/,
  );
  assert.deepEqual(h.sent, []);
});

test("send starts the turn, writes the input and ends the lease when the turn completes", async () => {
  const h = lifecycle();
  h.runtime.preparedTurnId = "turn-1";
  h.runtime.toolCalls.set("old", {} as never);
  h.runtime.activeNativeMessageId = "old-message";
  const sending = h.subject.send(h.command(), h.prepared());
  const turn = h.runtime.activeTurn!;
  assert.equal(turn.hostTurnId, "turn-1");
  assert.equal(h.runtime.toolCalls.size, 0);
  assert.equal(h.runtime.activeNativeMessageId, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  turn.completion.resolve();
  await sending;
  assert.deepEqual(h.sent, ["hello"]);
  assert.deepEqual(eventKinds(h.events), ["turn.started", "message.finished"]);
  assert.equal(h.runtime.preparedTurnId, undefined);
  assert.deepEqual(h.gatewayCalls, [`end:${GRANT}:turn-1`]);
});

test("a failed write marks the accepted turn unknown and a gone lease is tolerated", async () => {
  const h = lifecycle();
  h.runtime.preparedTurnId = "turn-1";
  h.failSend(new Error("stdin closed"));
  h.failEndLease();
  await assert.rejects(h.subject.send(h.command(), h.prepared()), /stdin closed/);
  assert.deepEqual(h.portCalls, [
    "unknown:turn-1:Claude did not confirm the accepted turn outcome.",
  ]);
  assert.equal(h.runtime.preparedTurnId, undefined);

  const settled = lifecycle();
  settled.runtime.preparedTurnId = "turn-1";
  const sending = settled.subject.send(settled.command(), settled.prepared());
  const turn = settled.runtime.activeTurn!;
  settled.runtime.activeTurn = undefined;
  turn.completion.reject(new Error("turn failed"));
  await assert.rejects(sending, /turn failed/);
  assert.deepEqual(settled.portCalls, [], "a turn that already left the runtime is not re-marked");
});

test("a lease renewal failure during send fails the runtime and stops it", async () => {
  let authorized = true;
  const h = lifecycle({ authorized: () => authorized, renewMs: 5 });
  h.runtime.preparedTurnId = "turn-1";
  const sending = h.subject.send(h.command(), h.prepared());
  const turn = h.runtime.activeTurn!;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(h.gatewayCalls.includes(`renewLease:${GRANT}:turn-1`));
  authorized = false;
  while (!h.portCalls.includes("stop")) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(h.runtime.failed?.message ?? "", /revoked during the active turn/);
  turn.completion.resolve();
  await sending;
});
