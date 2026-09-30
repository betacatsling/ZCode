/**
 * C4: reopening a Claude session after SessionHost.close() must not skip the startup binding checks
 * (validateClaudePlan, assertClaudeGrantMatchesBinding -> ClaudeBindingMismatchError
 * "invalid-binding") by adopting the old adapter's still-running runtime.
 *
 * Why it can happen:
 * - SessionHost.close() closes the journals and unsubscribes. It never calls adapter.terminate(), so
 *   the Claude runtime (process, Gateway grant, hook server) stays registered and running.
 * - ClaudeHarnessAdapter.attach() reuses a registered runtime whose binding matches, whose process
 *   runs and which has not failed, without startClaudeSession. A forced close (broken event stream)
 *   mid-turn leaves the turn itself live in that runtime too.
 * - AgentHostTargetService.close() shuts the harnesses down before closing hosts, so the normal
 *   close -> reopen path cannot reuse a runtime. It is still reachable through the target: a
 *   SessionHost.create() whose first sidecar write fails closes its host after adapter.create(), and
 *   the next TargetService.attach() finds the runtime.
 * - The first send re-plans; a changed plan rebinds through startClaudeSession and its grant check.
 *
 * Fix: attach() revalidates a live runtime (revalidateClaudeRuntime: plan, Model, authorization and
 * the runtime's grant against the reopening plan). A mismatch stops the runtime (process, grant,
 * hook server, registry entry; a live turn settles unknown) and rejects with the startup error; a
 * match reuses it as before, with no second grant.
 *
 * Binding B = a new catalog fingerprint plus a Gateway that tampers grants: a fresh start refuses it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { EventStreamFailure, SessionHost } from "../src/agent-host/sessionHost.js";
import { ClaudeHarnessAdapter } from "../src/agent-adapters/claude/claudeHarnessAdapter.js";
import { eventsOf } from "./fixtures/claudeAdapterHarness.js";
import { fakeClaudeLauncher } from "./fixtures/claudeFakeProcess.js";
import {
  breakHostStream,
  fingerprintA,
  FINGERPRINT_B,
  isGrantMismatch,
  mismatchBindingB,
  occupySidecar,
  reopenHarness,
  sendCommand,
  withTargetService,
  type ReopenHarness,
} from "./fixtures/claudeReopenHarness.js";
import { CLAUDE_UNIT, fakeClaudeModel } from "./fixtures/claudeUnitFixtures.js";

const TEST_TIMEOUT_MS = 20_000;

/** Opens and, if it opened, closes again; returns "reopened" or the rejection. */
async function reopenOutcome(r: ReopenHarness): Promise<unknown> {
  return SessionHost.open(r.options).then(
    async (host) => {
      await host.close();
      return "reopened";
    },
    (error: unknown) => error,
  );
}

function restoreBindingA(r: ReopenHarness): void {
  r.state.fingerprint = fingerprintA(r);
  r.state.tamper = false;
}

/** Creates the session and leaves one accepted turn open, then force-closes its host. */
async function forceCloseMidTurn(r: ReopenHarness, turnId: string): Promise<SessionHost> {
  const created = await SessionHost.create(r.options);
  const receipt = await created.dispatch(sendCommand(r.h.spec, turnId));
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
  await assert.rejects(created.close(), /active turn/, "a healthy close refuses the open turn");
  breakHostStream(r, created);
  await assert.rejects(created.whenEventsSettled(), /foreign event identity/);
  await assert.rejects(created.close(), EventStreamFailure);
  return created;
}

test(
  "control: after the adapter shut down, reopen starts a new runtime and the grant check refuses binding B",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    assert.equal(r.h.launches.length, 1);
    await created.close();
    await r.h.adapter.shutdown();
    assert.equal(r.h.launches[0]!.isRunning, false, "adapter shutdown stops the process");

    const resumed = fakeClaudeLauncher();
    const adapter = new ClaudeHarnessAdapter({
      root: r.h.root,
      executablePath: r.executablePath,
      targetModelGateway: r.h.targetModelGateway,
      modelFactory: () => fakeClaudeModel(),
      isMessagesSelection: () => true,
      fakeModelCompatibilityEvidence: (selection) => ({
        providerId: selection.providerId,
        modelId: selection.modelId,
        fixtureId: CLAUDE_UNIT.fixtureId,
      }),
      launchProcess: resumed.launchProcess,
    });
    t.after(() => adapter.shutdown());
    const registry = new HarnessRegistry();
    registry.register(adapter);

    mismatchBindingB(r);
    await assert.rejects(SessionHost.open({ ...r.options, registry }), isGrantMismatch);
    assert.deepEqual(r.grantFingerprints, [fingerprintA(r), FINGERPRINT_B]);
    assert.equal(resumed.launches.length, 0, "the refused grant launches nothing");
  },
);

test(
  "a matching reopen after SessionHost.close() reuses the live runtime: no second grant, nothing revoked",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    const [process] = r.h.launches;
    await created.close();
    assert.equal(process!.isRunning, true, "SessionHost.close() does not stop the process");

    // A tampering Gateway is never asked: reuse creates no grant.
    r.state.tamper = true;
    const reopened = await SessionHost.open(r.options);
    try {
      assert.deepEqual(r.grantFingerprints, [fingerprintA(r)], "no second grant");
      assert.deepEqual(r.h.grants.revoked, [], "the reused grant is not revoked");
      assert.equal(r.h.launches.length, 1, "the live process is reused");
      assert.equal(reopened.binding.runtimeEpoch, created.binding.runtimeEpoch);
      assert.equal(process!.isRunning, true);
    } finally {
      await reopened.close();
    }
  },
);

test(
  "fixed: reopen after SessionHost.close() with binding B is refused as invalid-binding and stops the old runtime",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    const [process] = r.h.launches;
    await created.close();

    mismatchBindingB(r);
    const outcome = await reopenOutcome(r);
    assert.ok(
      isGrantMismatch(outcome),
      `expected ClaudeBindingMismatchError, got ${String(outcome)}`,
    );
    assert.equal(process!.isRunning, false, "the refused reopen stops the old process");
    assert.ok(r.h.grants.revoked.includes(r.h.grants.created[0]!), "and revokes its grant");
    assert.equal(r.h.launches.length, 1, "nothing is launched for binding B");

    restoreBindingA(r);
    const again = await SessionHost.open(r.options);
    try {
      assert.equal(r.h.launches.length, 2, "a matching reopen then resumes on a new process");
      assert.equal(r.h.launches[1]!.resumed, true);
    } finally {
      await again.close();
    }
  },
);

test(
  "known: a matching reopen after a forced close mid-turn still adopts the live runtime and its turn",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const turnId = "turn-open-at-close";
    const created = await forceCloseMidTurn(r, turnId);
    const [process] = r.h.launches;
    assert.equal(process!.isRunning, true, "the force-close leaves the process running");
    assert.ok(r.h.adapter.renewTurnLease(r.h.spec.hostSessionId, turnId).expiresAt > 0);

    const reopened = await SessionHost.open(r.options);
    try {
      assert.deepEqual(r.grantFingerprints, [fingerprintA(r)], "no second grant");
      assert.equal(r.h.launches.length, 1);
      assert.equal(reopened.binding.runtimeEpoch, created.binding.runtimeEpoch);
      assert.ok(
        r.h.adapter.renewTurnLease(r.h.spec.hostSessionId, turnId).expiresAt > 0,
        "the old host's turn is still live in the adopted runtime",
      );
    } finally {
      await reopened.close();
    }
  },
);

test(
  "fixed: after a forced close mid-turn, reopen with binding B is refused and the live turn is terminated, not adopted",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const turnId = "turn-open-at-close";
    await forceCloseMidTurn(r, turnId);
    const [process] = r.h.launches;

    mismatchBindingB(r);
    const outcome = await reopenOutcome(r);
    assert.ok(
      isGrantMismatch(outcome),
      `expected ClaudeBindingMismatchError, got ${String(outcome)}`,
    );
    assert.equal(process!.isRunning, false, "the old process is terminated");
    assert.ok(r.h.grants.revoked.includes(r.h.grants.created[0]!), "its grant is revoked");
    assert.throws(
      () => r.h.adapter.renewTurnLease(r.h.spec.hostSessionId, turnId),
      /Claude Host session is not attached/,
      "the runtime left the registry",
    );
    assert.deepEqual(
      eventsOf(r.h.events, "turn.finished").map((event) => [event.turnId, event.outcome]),
      [[turnId, "unknown"]],
      "the live turn settles as unknown instead of being adopted",
    );
  },
);

test(
  "mitigation: a binding change after a matching reopen is refused as invalid-binding by the first send's rebind",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    await created.close();
    const reopened = await SessionHost.open(r.options);
    try {
      assert.deepEqual(r.grantFingerprints, [fingerprintA(r)]);
      mismatchBindingB(r);
      const receipt = await reopened.dispatch(sendCommand(r.h.spec, "turn-after-reopen"));
      assert.equal(receipt.status, "rejected", JSON.stringify(receipt));
      assert.equal(receipt.reasonCode, "invalid-binding");
      assert.match(receipt.message ?? "", /Claude Gateway grant differs from the captured binding/);
      assert.deepEqual(
        r.grantFingerprints,
        [fingerprintA(r), FINGERPRINT_B],
        "the send-time rebind is what finally reaches assertClaudeGrantMatchesBinding",
      );
    } finally {
      await reopened.close();
    }
  },
);

test(
  "a TargetService.create failing after adapter.create leaves the runtime; a matching TargetService.attach reuses it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    await withTargetService(r, async (service) => {
      const free = await occupySidecar(r);
      await assert.rejects(service.create(r.h.spec), { syscall: "rename" });
      const [process] = r.h.launches;
      assert.equal(process!.isRunning, true, "the failed create closed its host, not the runtime");

      await free();
      await service.attach(r.h.spec);
      assert.deepEqual(r.grantFingerprints, [fingerprintA(r)], "no second grant");
      assert.equal(r.h.launches.length, 1, "the attach reused the orphaned process");
    });
  },
);

test(
  "fixed: TargetService.attach after that failed create refuses binding B and stops the orphaned runtime",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    await withTargetService(r, async (service) => {
      const free = await occupySidecar(r);
      await assert.rejects(service.create(r.h.spec), { syscall: "rename" });
      const [process] = r.h.launches;

      await free();
      mismatchBindingB(r);
      const outcome = await service.attach(r.h.spec).then(
        () => "attached",
        (error: unknown) => error,
      );
      assert.ok(
        isGrantMismatch(outcome),
        `expected ClaudeBindingMismatchError, got ${String(outcome)}`,
      );
      assert.equal(process!.isRunning, false, "the orphaned runtime is stopped");

      restoreBindingA(r);
      await service.attach(r.h.spec);
      assert.equal(r.h.launches.length, 2, "a matching attach then resumes on a new process");
    });
  },
);

test(
  "safe: TargetService.close() shuts the adapter down first, so the runtime stops and a reopen on that registry is refused",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    await withTargetService(r, async (first) => {
      await first.create(r.h.spec);
    });
    assert.equal(r.h.launches[0]!.isRunning, false, "harness shutdown stopped the process");
    assert.deepEqual(r.h.grants.revoked, r.h.grants.created, "and revoked its grant");

    mismatchBindingB(r);
    await withTargetService(r, async (second) => {
      await assert.rejects(second.attach(r.h.spec), /Claude target host is shutting down/);
    });
    assert.deepEqual(r.grantFingerprints, [fingerprintA(r)], "nothing was reused");
    assert.equal(r.h.launches.length, 1);
  },
);
