import assert from "node:assert/strict";
import test from "node:test";
import type { BackendBinding } from "@zcode/shared/agent-host";
import { PINNED_CLAUDE_CLI_VERSION } from "../src/agent-adapters/claude/claudeExecutable.js";
import {
  claudeAdapterHarness,
  eventsOf,
  preparedTurn,
  startTurn,
  type ClaudeAdapterHarness,
} from "./fixtures/claudeAdapterHarness.js";
import type { FakeClaudeProcess, FakeClaudeProcessBehavior } from "./fixtures/claudeFakeProcess.js";

// A10: attach / terminate branches of ClaudeHarnessAdapter over the launchProcess hook.

const answering = { onSend: (process: FakeClaudeProcess) => process.result() };

function journalBinding(h: ClaudeAdapterHarness): BackendBinding {
  return {
    hostSessionId: h.spec.hostSessionId,
    backendSessionId: "native-from-journal",
    backendVersion: PINNED_CLAUDE_CLI_VERSION,
    runtimeEpoch: "epoch-from-journal",
  };
}

function gatedLaunch(): {
  behavior: FakeClaudeProcessBehavior;
  launched: Promise<void>;
  release: () => void;
} {
  let release!: () => void;
  let launched!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    launched: new Promise<void>((resolve) => {
      launched = resolve;
    }),
    release: () => release(),
    behavior: {
      ...answering,
      onLaunch: async () => {
        launched();
        await gate;
      },
    },
  };
}

test("attach resumes the journaled native session and continues its sequence", async (t) => {
  const h = await claudeAdapterHarness(t, { behavior: answering });
  await h.adapter.attach(h.spec, journalBinding(h), 7, h.plan);
  const [process] = h.launches;
  assert.equal(process?.resumed, true);
  assert.equal(process.nativeSessionId, "native-from-journal");
  const { sending } = await startTurn(h, "turn-after-attach");
  await sending;
  assert.equal(h.events[0]?.sequence, 8, "the first event follows the last journal sequence");
  assert.equal(h.events[0]?.runtimeEpoch, "epoch-from-journal");
});

test("attach is a no-op for the healthy current binding and refuses a stale one", async (t) => {
  const h = await claudeAdapterHarness(t);
  const binding = await h.adapter.create(h.spec, h.plan);
  await h.adapter.attach(h.spec, binding, 0, h.plan);
  assert.equal(h.launches.length, 1);
  await assert.rejects(
    h.adapter.attach(h.spec, { ...binding, backendSessionId: "native-other" }, 0, h.plan),
    /stale Claude backend binding/,
  );
  await assert.rejects(
    h.adapter.attach(h.spec, { ...binding, runtimeEpoch: "epoch-other" }, 0, h.plan),
    /stale Claude backend binding/,
  );
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0]!.calls, [], "the current runtime keeps running");
});

test("attach replaces an exited or failed current runtime with a resumed one", async (t) => {
  const h = await claudeAdapterHarness(t);
  const binding = await h.adapter.create(h.spec, h.plan);
  h.launches[0]!.exit();
  await h.adapter.attach(h.spec, binding, 3, h.plan);
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1]!.resumed, true);
  assert.equal(h.launches[1]!.nativeSessionId, binding.backendSessionId);
  assert.deepEqual(h.launches[0]!.calls, ["terminate"]);

  h.launches[1]!.fail(new Error("Claude Code process exited without a terminal result"));
  await h.adapter.attach(h.spec, binding, 5, h.plan);
  assert.equal(h.launches.length, 3);
  assert.deepEqual(h.launches[1]!.calls, ["terminate"]);
  assert.equal(h.grants.created.length, 3);
  // The failed runtime revoked its own grant; stopping it revokes again (idempotent).
  assert.deepEqual([...new Set(h.grants.revoked)], h.grants.created.slice(0, 2));
});

test("attach and create refuse while the same session is starting or running", async (t) => {
  const gated = gatedLaunch();
  const h = await claudeAdapterHarness(t, { behavior: gated.behavior });
  const creating = h.adapter.create(h.spec, h.plan);
  await gated.launched;
  await assert.rejects(
    h.adapter.attach(h.spec, journalBinding(h), 0, h.plan),
    /Claude session is already starting/,
  );
  await assert.rejects(h.adapter.create(h.spec, h.plan), /duplicate Claude Host session/);
  gated.release();
  await creating;
  await assert.rejects(h.adapter.create(h.spec, h.plan), /duplicate Claude Host session/);
  assert.equal(h.launches.length, 1);
});

for (const entry of ["create", "attach"] as const) {
  test(`shutdown while ${entry} is starting stops the new runtime`, async (t) => {
    const gated = gatedLaunch();
    const h = await claudeAdapterHarness(t, { behavior: gated.behavior });
    const starting =
      entry === "create"
        ? h.adapter.create(h.spec, h.plan)
        : h.adapter.attach(h.spec, journalBinding(h), 0, h.plan);
    void starting.catch(() => undefined);
    await gated.launched;
    const shuttingDown = h.adapter.shutdown();
    gated.release();
    await assert.rejects(starting, /Claude target host is shutting down/);
    await shuttingDown;
    assert.deepEqual(h.launches[0]!.calls, ["terminate"]);
    assert.deepEqual(h.grants.revoked, h.grants.created);
    assert.throws(
      () => h.adapter.renewTurnLease(h.spec.hostSessionId, "turn"),
      /Claude Host session is not attached/,
    );
  });
}

test("terminate stops and unregisters the runtime; a later create starts fresh", async (t) => {
  const h = await claudeAdapterHarness(t);
  const first = await h.adapter.create(h.spec, h.plan);
  await h.adapter.terminate(h.spec.hostSessionId);
  await h.adapter.terminate(h.spec.hostSessionId);
  assert.deepEqual(h.launches[0]!.calls, ["terminate"]);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  await assert.rejects(
    h.adapter.prepareTurn(h.spec, preparedTurn(h.plan, "turn-1")),
    /Claude Host session is not attached/,
  );
  const second = await h.adapter.create(h.spec, h.plan);
  assert.notEqual(second.backendSessionId, first.backendSessionId);
  assert.equal(h.launches[1]!.resumed, false);
});

test("terminate during an active turn settles it as execution-unknown", async (t) => {
  const h = await claudeAdapterHarness(t);
  await h.adapter.create(h.spec, h.plan);
  const { sending } = await startTurn(h, "turn-running");
  await h.adapter.terminate(h.spec.hostSessionId);
  await assert.rejects(sending, /may have executed/);
  assert.deepEqual(
    eventsOf(h.events, "turn.finished").map((event) => event.outcome),
    ["unknown"],
  );
  assert.deepEqual(
    eventsOf(h.events, "session.error").map((event) => event.code),
    ["execution-unknown"],
  );
  assert.deepEqual(h.launches[0]!.calls, ["terminate"]);
});
