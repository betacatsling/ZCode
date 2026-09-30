/**
 * C4 step 1 repro (characterization only; nothing is fixed here).
 *
 * The question: after SessionHost.close(), does reopening the same Claude session reuse the old
 * adapter's still-running runtime and so skip the binding checks of startClaudeSession
 * (validateClaudePlan, assertClaudeGrantMatchesBinding -> ClaudeBindingMismatchError
 * "invalid-binding")?
 *
 * What these tests pin:
 * - SessionHost.close() closes the journals and unsubscribes. It never calls adapter.terminate(), so
 *   the Claude runtime (process, Gateway grant, hook server) stays registered and running.
 * - ClaudeHarnessAdapter.attach() returns early for a registered runtime whose binding matches, whose
 *   process runs and which has not failed. SessionHost.open() therefore mounts that runtime without
 *   startClaudeSession: no plan or grant check, no new grant, even when the plan changed. A forced
 *   close (broken event stream) mid-turn leaves the turn itself live in the reused runtime too.
 * - AgentHostTargetService.close() shuts the harnesses down before closing hosts, so the normal
 *   close -> reopen path cannot reuse a runtime. It is still reachable through the target: a
 *   SessionHost.create() whose first sidecar write fails closes its host after adapter.create(), and
 *   the next TargetService.attach() reuses the runtime without a grant check.
 * - Mitigation: the first send re-plans; a changed plan rebinds through startClaudeSession, where
 *   the grant check refuses it as invalid-binding.
 *
 * Tests named "CURRENT" pin today's behavior. "EXPECTED" tests assert the correct behavior and are
 * todo until C4 fixes it, so CI stays green.
 *
 * Grant tampering (a Gateway that returns a grant for another catalog fingerprint) is the probe for
 * "reaches assertClaudeGrantMatchesBinding": a fresh start refuses it, a reused runtime never asks.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentEventSchema,
  type AgentEvent,
  type ExecutionTarget,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import type { ModelCatalogPort } from "../src/agent-host/modelBindingPlanner.js";
import { EventStreamFailure, SessionHost } from "../src/agent-host/sessionHost.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import { ClaudeBindingMismatchError } from "../src/agent-adapters/claude/claudeBindingGuards.js";
import { ClaudeHarnessAdapter } from "../src/agent-adapters/claude/claudeHarnessAdapter.js";
import { claudeAdapterHarness } from "./fixtures/claudeAdapterHarness.js";
import { fakeClaudeLauncher } from "./fixtures/claudeFakeProcess.js";
import { CLAUDE_UNIT, fakeClaudeModel } from "./fixtures/claudeUnitFixtures.js";

const TEST_TIMEOUT_MS = 20_000;
const FINGERPRINT_B = "catalog-claude-unit-b";

async function pinnedClaudeScript(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-claude-reopen-pinned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "claude");
  await writeFile(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.263 (Claude Code)"; exit 0; fi\nexec cat >/dev/null\n',
    { mode: 0o700 },
  );
  return path;
}

/** Claude adapter over the fake launcher, a mutable catalog and a Gateway that can tamper grants. */
async function reopenHarness(t: test.TestContext) {
  const executablePath = await pinnedClaudeScript(t);
  const h = await claudeAdapterHarness(t, { adapter: { executablePath } });
  const root = join(h.root, "host");
  await mkdir(root, { mode: 0o700 });
  const registry = new HarnessRegistry();
  registry.register(h.adapter);
  const target: ExecutionTarget = {
    id: h.spec.execution.targetId,
    kind: "local",
    platform: process.platform as ExecutionTarget["platform"],
    available: true,
  };
  const state = { fingerprint: h.plan.catalogFingerprint, tamper: false };
  const catalog: ModelCatalogPort = {
    get fingerprint() {
      return state.fingerprint;
    },
    validateSelection: () => ({ ok: true }),
  };
  const gateway = h.targetModelGateway.get(h.spec.execution.targetId);
  const recordingCreate = gateway.createGrant;
  /** Fingerprint of every grant the Gateway was asked for (i.e. every startClaudeSession). */
  const grantFingerprints: string[] = [];
  gateway.createGrant = (input) => {
    grantFingerprints.push(input.modelBindingFingerprint);
    const grant = recordingCreate(input);
    return state.tamper ? { ...grant, modelBindingFingerprint: "tampered-fingerprint" } : grant;
  };
  // SessionHost's adapter subscriptions, so a test can feed one an event that breaks its stream.
  const listeners: ((event: AgentEvent) => void)[] = [];
  const subscribe = h.adapter.subscribe.bind(h.adapter);
  h.adapter.subscribe = (hostSessionId, listener) => {
    listeners.push(listener);
    return subscribe(hostSessionId, listener);
  };
  const options = { root, spec: h.spec, target, catalog, registry };
  return {
    h,
    executablePath,
    root,
    registry,
    target,
    catalog,
    state,
    grantFingerprints,
    listeners,
    options,
  };
}

type ReopenHarness = Awaited<ReturnType<typeof reopenHarness>>;

/** Changes the captured binding (new catalog fingerprint) and makes the Gateway tamper grants. */
function mismatchBindingB(r: ReopenHarness): void {
  r.state.fingerprint = FINGERPRINT_B;
  r.state.tamper = true;
}

function isGrantMismatch(error: unknown): boolean {
  return (
    error instanceof ClaudeBindingMismatchError &&
    error.code === "invalid-binding" &&
    error.mismatch === "grant"
  );
}

function sendCommand(spec: SessionSpec, turnId: string) {
  return {
    type: "send" as const,
    commandId: `send-${turnId}`,
    hostSessionId: spec.hostSessionId,
    turnId,
    text: `run ${turnId}`,
  };
}

function sidecarPathFor(root: string, spec: SessionSpec): string {
  const identity = [
    spec.execution.targetId,
    spec.execution.workspaceIdentity,
    spec.harness.id,
    spec.hostSessionId,
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return join(root, `${digest}.activity.json`);
}

/** Runs with a TargetService closed before the fixture's t.after hooks remove the root. */
async function withTargetService(
  r: ReopenHarness,
  run: (service: AgentHostTargetService) => Promise<void>,
): Promise<void> {
  const service = new AgentHostTargetService({
    root: r.root,
    target: r.target,
    catalog: r.catalog,
    registry: r.registry,
    authorizeWorktree: async () => true,
  });
  try {
    await run(service);
  } finally {
    await service.close();
  }
}

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
  "CURRENT (C4 bug): SessionHost.close() leaves the Claude runtime running and reopen reuses it without the grant check",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    const [process] = r.h.launches;
    await created.close();
    assert.equal(process!.isRunning, true, "SessionHost.close() does not stop the process");
    assert.deepEqual(r.h.grants.revoked, [], "nor revoke its grant");

    mismatchBindingB(r);
    const reopened = await SessionHost.open(r.options);
    try {
      assert.equal(reopened.plan.catalogFingerprint, FINGERPRINT_B, "the host now holds binding B");
      assert.deepEqual(
        r.grantFingerprints,
        [fingerprintA(r)],
        "no grant was requested for B, so assertClaudeGrantMatchesBinding never ran",
      );
      assert.equal(r.h.launches.length, 1, "no new process: the old one was adopted");
      assert.equal(reopened.binding.runtimeEpoch, created.binding.runtimeEpoch);
      assert.equal(process!.isRunning, true);
    } finally {
      await reopened.close();
    }
  },
);

test(
  "EXPECTED: reopen after SessionHost.close() reaches the grant check and refuses binding B",
  {
    timeout: TEST_TIMEOUT_MS,
    todo: "C4: reopen reuses the live Claude runtime (attach early return)",
  },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    await created.close();

    mismatchBindingB(r);
    const outcome = await reopenOutcome(r);
    assert.ok(
      isGrantMismatch(outcome),
      `expected ClaudeBindingMismatchError, got ${String(outcome)}`,
    );
    assert.deepEqual(r.grantFingerprints, [fingerprintA(r), FINGERPRINT_B]);
  },
);

test(
  "CURRENT (C4 bug): a forced close mid-turn leaves the turn live; reopen adopts it without the grant check",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    const turnId = "turn-open-at-close";
    const receipt = await created.dispatch(sendCommand(r.h.spec, turnId));
    assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
    await assert.rejects(created.close(), /active turn/, "a healthy close refuses the open turn");

    // A foreign event on the host's subscription breaks its stream; close() then force-closes.
    r.listeners.at(-1)!(
      agentEventSchema.parse({
        hostSessionId: "claude-foreign-session",
        runtimeEpoch: created.binding.runtimeEpoch,
        sequence: 1_000,
        eventId: "claude-foreign-1000",
        at: 1_000,
        kind: "session.status",
        state: "running",
      }),
    );
    await assert.rejects(created.whenEventsSettled(), /foreign event identity/);
    await assert.rejects(created.close(), EventStreamFailure);
    const [process] = r.h.launches;
    assert.equal(process!.isRunning, true, "the force-close leaves the process running");
    assert.ok(r.h.adapter.renewTurnLease(r.h.spec.hostSessionId, turnId).expiresAt > 0);

    mismatchBindingB(r);
    const reopened = await SessionHost.open(r.options);
    try {
      assert.deepEqual(r.grantFingerprints, [fingerprintA(r)], "no grant check for B");
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
  "EXPECTED: after a forced close mid-turn, reopen reaches the grant check and refuses binding B",
  { timeout: TEST_TIMEOUT_MS, todo: "C4: forced close leaves the Claude runtime and turn live" },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    const receipt = await created.dispatch(sendCommand(r.h.spec, "turn-open-at-close"));
    assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
    r.listeners.at(-1)!(
      agentEventSchema.parse({
        hostSessionId: "claude-foreign-session",
        runtimeEpoch: created.binding.runtimeEpoch,
        sequence: 1_000,
        eventId: "claude-foreign-1000",
        at: 1_000,
        kind: "session.status",
        state: "running",
      }),
    );
    await assert.rejects(created.whenEventsSettled(), /foreign event identity/);
    await assert.rejects(created.close(), EventStreamFailure);

    mismatchBindingB(r);
    const outcome = await reopenOutcome(r);
    assert.ok(
      isGrantMismatch(outcome),
      `expected ClaudeBindingMismatchError, got ${String(outcome)}`,
    );
  },
);

test(
  "CURRENT (mitigation): the first send after that reopen rebinds for binding B and is refused as invalid-binding",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const created = await SessionHost.create(r.options);
    await created.close();
    mismatchBindingB(r);
    const reopened = await SessionHost.open(r.options);
    try {
      assert.deepEqual(r.grantFingerprints, [fingerprintA(r)]);
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
  "CURRENT (C4 bug): TargetService.create failing after adapter.create leaves the runtime; TargetService.attach reuses it without the grant check",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    await withTargetService(r, async (service) => {
      // A non-empty directory where the first activity sidecar goes: its atomic rename fails.
      const sidecar = sidecarPathFor(r.root, r.h.spec);
      await mkdir(sidecar, { recursive: true });
      await writeFile(join(sidecar, "occupied"), "");
      await assert.rejects(service.create(r.h.spec), { syscall: "rename" });
      const [process] = r.h.launches;
      assert.equal(process!.isRunning, true, "the failed create closed its host, not the runtime");

      await rm(sidecar, { recursive: true });
      mismatchBindingB(r);
      await service.attach(r.h.spec);
      assert.deepEqual(r.grantFingerprints, [fingerprintA(r)], "no grant check for B");
      assert.equal(r.h.launches.length, 1, "the attach adopted the orphaned process");
    });
  },
);

test(
  "EXPECTED: TargetService.attach after that failed create reaches the grant check and refuses binding B",
  {
    timeout: TEST_TIMEOUT_MS,
    todo: "C4: a failed SessionHost.create leaves the Claude runtime for the next attach",
  },
  async (t) => {
    const r = await reopenHarness(t);
    await withTargetService(r, async (service) => {
      const sidecar = sidecarPathFor(r.root, r.h.spec);
      await mkdir(sidecar, { recursive: true });
      await writeFile(join(sidecar, "occupied"), "");
      await assert.rejects(service.create(r.h.spec), { syscall: "rename" });

      await rm(sidecar, { recursive: true });
      mismatchBindingB(r);
      const outcome = await service.attach(r.h.spec).then(
        () => "attached",
        (error: unknown) => error,
      );
      assert.ok(
        isGrantMismatch(outcome),
        `expected ClaudeBindingMismatchError, got ${String(outcome)}`,
      );
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

function fingerprintA(r: ReopenHarness): string {
  return r.h.plan.catalogFingerprint;
}
