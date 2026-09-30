import assert from "node:assert/strict";
import test from "node:test";
import { replaceClaudeIdleBinding } from "../src/agent-adapters/claude/claudeSessionStartup.js";
import type { ClaudeSessionStartupContext } from "../src/agent-adapters/claude/claudeSessionStartup.js";
import {
  claudeAdapterHarness,
  eventsOf,
  preparedTurn,
  startTurn,
  type ClaudeAdapterHarness,
} from "./fixtures/claudeAdapterHarness.js";
import type { FakeClaudeProcess } from "./fixtures/claudeFakeProcess.js";
import { claudeUnitRuntime, claudeUnitTurn } from "./fixtures/claudeUnitFixtures.js";

// A9: idle rebind replaces the runtime on a resumed native session and keeps the Host binding.

async function completeTurn(h: ClaudeAdapterHarness, turnId: string, plan = h.plan) {
  const { sending } = await startTurn(h, turnId, plan);
  await sending;
}

function assertContiguousSequences(h: ClaudeAdapterHarness): void {
  const sequences = h.events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_, index) => index + 1),
    "the rebound runtime continues the event sequence",
  );
}

const answering = { onSend: (process: FakeClaudeProcess) => process.result() };

test("a changed binding plan rebinds an idle runtime on a resumed process", async (t) => {
  const h = await claudeAdapterHarness(t, { behavior: answering });
  const binding = await h.adapter.create(h.spec, h.plan);
  await completeTurn(h, "turn-1");
  const [first] = h.launches;

  const rebindPlan = { ...h.plan, catalogFingerprint: "catalog-claude-unit-v2" };
  await completeTurn(h, "turn-2", rebindPlan);
  assert.equal(h.launches.length, 2);
  const second = h.launches[1]!;
  assert.equal(second.resumed, true);
  assert.equal(second.nativeSessionId, binding.backendSessionId);
  assert.deepEqual(first!.calls, ["terminate"]);
  assert.deepEqual(second.sent, ["run turn-2"]);
  assert.equal(h.grants.created.length, 2);
  assert.deepEqual(h.grants.revoked, [h.grants.created[0]]);
  assert.equal(await first!.gatewayStatus(), 401);
  assert.equal(await second.gatewayStatus(), 400);
  assert.deepEqual(
    eventsOf(h.events, "turn.finished").map((event) => event.outcome),
    ["success", "success"],
  );
  assertContiguousSequences(h);

  // Re-attaching with the original binding is a no-op: epoch and native session are unchanged.
  await h.adapter.attach(h.spec, binding, 0, rebindPlan);
  assert.equal(h.launches.length, 2);
});

test("an unchanged plan renews the grant on the same process", async (t) => {
  const h = await claudeAdapterHarness(t, { behavior: answering });
  await h.adapter.create(h.spec, h.plan);
  await completeTurn(h, "turn-1");
  await completeTurn(h, "turn-2");
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0]!.sent, ["run turn-1", "run turn-2"]);
  assert.deepEqual(h.grants.revoked, []);
});

test("an exited or failed idle process is rebound before the next turn", async (t) => {
  const h = await claudeAdapterHarness(t, { behavior: answering });
  await h.adapter.create(h.spec, h.plan);
  h.launches[0]!.exit();
  await completeTurn(h, "turn-after-exit");
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1]!.resumed, true);

  h.launches[1]!.fail(new Error("Claude Code process exited without a terminal result"));
  assert.deepEqual(
    eventsOf(h.events, "session.error").map((event) => event.code),
    ["claude-process-failure"],
  );
  await completeTurn(h, "turn-after-failure");
  assert.equal(h.launches.length, 3);
  assert.deepEqual(h.launches[2]!.sent, ["run turn-after-failure"]);
  assertContiguousSequences(h);
});

test("a failed rebind keeps the failed runtime so the next turn retries", async (t) => {
  let failNextLaunch = false;
  const h = await claudeAdapterHarness(t, {
    behavior: {
      ...answering,
      onLaunch: () => {
        if (!failNextLaunch) return;
        failNextLaunch = false;
        throw new Error("spawn EAGAIN");
      },
    },
  });
  await h.adapter.create(h.spec, h.plan);
  h.launches[0]!.exit();
  failNextLaunch = true;
  await assert.rejects(
    h.adapter.prepareTurn(h.spec, preparedTurn(h.plan, "turn-1")),
    /spawn EAGAIN/,
  );
  assert.deepEqual(h.launches[0]!.calls, ["terminate"], "the previous runtime was stopped");
  assert.equal(h.grants.created.length, 2);
  assert.deepEqual(h.grants.revoked, h.grants.created, "both grants are released");
  // The failed previous runtime is still registered, so the next turn retries the rebind.
  await completeTurn(h, "turn-2");
  assert.equal(h.launches.length, 3);
  assert.equal(h.launches[2]!.resumed, true);
});

test("shutdown during a rebind stops the rebound runtime", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let launched!: () => void;
  const secondLaunch = new Promise<void>((resolve) => {
    launched = resolve;
  });
  const h = await claudeAdapterHarness(t, {
    behavior: {
      onLaunch: async (process) => {
        if (!process.resumed) return;
        launched();
        await gate;
      },
    },
  });
  await h.adapter.create(h.spec, h.plan);
  h.launches[0]!.exit();
  const preparing = h.adapter.prepareTurn(h.spec, preparedTurn(h.plan, "turn-1"));
  void preparing.catch(() => undefined);
  await secondLaunch;
  const shuttingDown = h.adapter.shutdown();
  release();
  await assert.rejects(preparing, /Claude target host is shutting down/);
  await shuttingDown;
  assert.deepEqual(h.launches[1]!.calls, ["terminate"]);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  assert.throws(
    () => h.adapter.renewTurnLease(h.spec.hostSessionId, "turn-1"),
    /Claude Host session is not attached/,
    "no runtime stays registered after shutdown",
  );
});

test("replaceClaudeIdleBinding refuses a runtime with an active or prepared turn", async () => {
  const ctx = {} as ClaudeSessionStartupContext;
  const prepared = preparedTurn(claudeUnitRuntime().runtime.plan, "turn-next");
  const active = claudeUnitRuntime();
  claudeUnitTurn(active.runtime, "turn-active");
  await assert.rejects(
    replaceClaudeIdleBinding(ctx, active.runtime, prepared),
    /Claude cannot replace its Model binding during an active turn/,
  );
  const reserved = claudeUnitRuntime();
  reserved.runtime.preparedTurnId = "turn-reserved";
  await assert.rejects(
    replaceClaudeIdleBinding(ctx, reserved.runtime, prepared),
    /Claude cannot replace its Model binding during an active turn/,
  );
  assert.deepEqual([...active.calls, ...reserved.calls], [], "nothing was stopped");
});
