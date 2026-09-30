/**
 * C4: the two remaining reopen entry points around a live Claude runtime.
 *
 * - SessionHost.open() whose attach started a runtime but whose first sidecar write then failed
 *   closes its host and leaves that runtime registered and running (sessionHost.ts open() catch).
 *   The next open must revalidate it: a matching binding reuses it, binding B is refused.
 * - The lazy target service: after dispose() every warm entry point refuses with "disposed" and the
 *   target (registry start, harness registration) is never rebuilt, so no runtime can be reused.
 *
 * Binding B = a new catalog fingerprint plus a Gateway that tampers grants (see claudeReopenHarness).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import {
  fingerprintA,
  isGrantMismatch,
  mismatchBindingB,
  occupySidecar,
  reopenHarness,
  type ReopenHarness,
} from "./fixtures/claudeReopenHarness.js";
import { claudeUnitPlan, claudeUnitSpec } from "./fixtures/claudeUnitFixtures.js";

const TEST_TIMEOUT_MS = 20_000;

/**
 * Creates the session, stops its first runtime, then makes an open() whose attach starts a second
 * runtime fail on its sidecar write. Returns that orphaned (live) second process.
 */
async function failOpenAfterAttach(r: ReopenHarness) {
  const created = await SessionHost.create(r.options);
  await created.close();
  await r.h.adapter.terminate(r.h.spec.hostSessionId);
  assert.equal(r.h.launches[0]!.isRunning, false);
  const free = await occupySidecar(r);
  await assert.rejects(SessionHost.open(r.options), { syscall: "rename" });
  await free();
  const orphan = r.h.launches[1]!;
  assert.equal(r.h.launches.length, 2, "the failed open's attach started a runtime");
  assert.equal(orphan.isRunning, true, "the failed open closed its host, not the runtime");
  return orphan;
}

test(
  "control: after an open() that failed past attach, a matching open reuses the orphaned runtime without a second grant",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const orphan = await failOpenAfterAttach(r);
    const grants = r.h.grants.created.length;

    r.state.tamper = true; // never asked: reuse creates no grant
    const reopened = await SessionHost.open(r.options);
    try {
      assert.equal(r.h.grants.created.length, grants, "no new grant");
      assert.equal(r.h.launches.length, 2, "the orphaned process is reused");
      assert.equal(orphan.isRunning, true);
    } finally {
      await reopened.close();
    }
  },
);

test(
  "fixed: after an open() that failed past attach, open with binding B is refused and stops the orphaned runtime",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const r = await reopenHarness(t);
    const orphan = await failOpenAfterAttach(r);
    const orphanGrant = r.h.grants.created.at(-1)!;

    mismatchBindingB(r);
    const outcome = await SessionHost.open(r.options).then(
      async (host) => {
        await host.close();
        return "reopened";
      },
      (error: unknown) => error,
    );
    assert.ok(
      isGrantMismatch(outcome),
      `expected ClaudeBindingMismatchError, got ${String(outcome)}`,
    );
    assert.equal(orphan.isRunning, false, "the orphaned process is terminated");
    assert.ok(r.h.grants.revoked.includes(orphanGrant), "and its grant revoked");
    assert.equal(r.h.launches.length, 2, "nothing is launched for binding B");
    assert.deepEqual(r.grantFingerprints, [fingerprintA(r), fingerprintA(r)]);
  },
);

const lazyTarget: ExecutionTarget = {
  id: "local-core-c4",
  kind: "local",
  platform: process.platform as ExecutionTarget["platform"],
  available: true,
};

test(
  "safe: after dispose() the lazy service refuses attach/create/dispatch as disposed and never rebuilds its target",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-c4-lazy-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let starts = 0;
    const registry = {
      start: async () => {
        starts += 1;
      },
      getProvider: () => ({ config: { api: { type: "anthropic-messages" } } }),
      validateSelection: () => ({ ok: true }),
    } as unknown as ProviderRegistryService;
    const harnesses: HarnessAdapter[] = [];
    const lazy = createLazyTargetAgentHostService({
      root,
      target: lazyTarget,
      registry,
      allowNewSessions: () => true,
      observeRegisteredHarness: (harness) => harnesses.push(harness),
    });
    // Warm the target once, as a real attach would.
    await lazy.service.getWorkspaceSessionCapability({
      harnessId: "claude-code",
      modelBinding: { kind: "harness-managed" },
    });
    assert.equal(starts, 1);
    const registered = harnesses.length;
    const claude = harnesses.find((harness) => harness.id === "claude-code")!;
    await lazy.dispose();

    const unit = claudeUnitSpec();
    const spec: SessionSpec = {
      ...unit,
      execution: { ...unit.execution, targetId: lazyTarget.id, worktreePath: root },
    };
    await assert.rejects(lazy.service.attach(spec), /agent host service disposed/);
    await assert.rejects(lazy.service.create(spec), /agent host service disposed/);
    await assert.rejects(
      lazy.service.dispatch(spec, {
        type: "send",
        commandId: "send-after-dispose",
        hostSessionId: spec.hostSessionId,
        turnId: "turn-after-dispose",
        text: "after dispose",
      }),
      /agent host service disposed/,
    );
    assert.equal(starts, 1, "the registry is not started again");
    assert.equal(harnesses.length, registered, "no harness is registered again");
    // The disposed target shut its harnesses down, so its Claude adapter refuses any attach.
    await assert.rejects(
      claude.attach(
        spec,
        {
          hostSessionId: spec.hostSessionId,
          backendSessionId: "native-after-dispose",
          backendVersion: claude.version,
          runtimeEpoch: "epoch-after-dispose",
        },
        0,
        claudeUnitPlan(spec),
      ),
      /Claude target host is shutting down/,
    );
  },
);
