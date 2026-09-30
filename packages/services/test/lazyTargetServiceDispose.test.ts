/**
 * createLazyTargetAgentHostService().dispose() is the only closer of the warm target service, the
 * shared TargetModelGateway and the history-only service. A failing close of one of them must not
 * leak the others, and the first close error must reach the caller unchanged (same object, so a
 * typed EventStreamFailure from a broken event stream stays matchable).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRegistryService } from "@zcode/provider";
import { TargetModelGateway } from "@zcode/services/model-gateway";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const TARGET_ID = "local";
/** Every close in these tests is millisecond-scale; fail fast instead of hanging CI. */
const TEST_TIMEOUT_MS = 15_000;

type LazyHost = ReturnType<typeof createLazyTargetAgentHostService>;

function fakeProviderRegistry(): ProviderRegistryService {
  return {
    start: async () => undefined,
    getProvider: () => undefined,
    validateSelection: () => ({ ok: false, reason: "fixture" }),
  } as unknown as ProviderRegistryService;
}

/**
 * Counts closes of the warm target (it has registered harnesses) and of the history-only service
 * (empty registry), and optionally fails them after the real close ran, so nothing actually leaks
 * from the test process.
 */
function instrumentCloses(
  shared: TargetModelGateway,
  failures: { target?: Error; gateway?: Error } = {},
) {
  const originalTargetClose = AgentHostTargetService.prototype.close;
  const originalGatewayClose = TargetModelGateway.prototype.close;
  const calls = { target: 0, history: 0, gateway: 0 };
  AgentHostTargetService.prototype.close = async function (this: AgentHostTargetService) {
    const warm = (await this.getAvailability()).harnesses.length > 0;
    if (warm) calls.target += 1;
    else calls.history += 1;
    await originalTargetClose.call(this);
    if (warm && failures.target) throw failures.target;
  };
  TargetModelGateway.prototype.close = async function (this: TargetModelGateway) {
    if (this !== shared) return originalGatewayClose.call(this);
    calls.gateway += 1;
    await originalGatewayClose.call(this);
    if (failures.gateway) throw failures.gateway;
  };
  return {
    calls,
    restore() {
      AgentHostTargetService.prototype.close = originalTargetClose;
      TargetModelGateway.prototype.close = originalGatewayClose;
    },
  };
}

async function withLazyHost(prefix: string, run: (host: LazyHost) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const host = createLazyTargetAgentHostService({
    root,
    target: {
      id: TARGET_ID,
      kind: "local",
      platform: process.platform as "linux",
      available: true,
    },
    registry: fakeProviderRegistry(),
    allowNewSessions: () => true,
  });
  try {
    await run(host);
  } finally {
    await host.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** Forces getTarget(): the lazy path registers the CLI harnesses and mounts the warm target. */
async function warm(host: LazyHost): Promise<void> {
  const capability = await host.service.getWorkspaceSessionCapability({
    harnessId: "codex",
    modelBinding: { kind: "harness-managed" },
  });
  assert.equal(capability.targetId, TARGET_ID);
}

function assertGatewayClosed(host: LazyHost): void {
  assert.throws(() => host.targetModelGateway.get(TARGET_ID), /Target Model Gateway is closed/);
}

function sameError(expected: Error) {
  return (error: unknown) => {
    assert.equal(error, expected, `expected the original close error, got ${String(error)}`);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Guards: behaviour that holds today and must keep holding
// ---------------------------------------------------------------------------

test(
  "cold dispose (target never warmed) closes the shared gateway and the history-only service",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withLazyHost("zcode-lazy-dispose-cold-", async (host) => {
      const probe = instrumentCloses(host.targetModelGateway);
      try {
        await host.dispose();
        assert.deepEqual(probe.calls, { target: 0, history: 1, gateway: 1 });
        assertGatewayClosed(host);
      } finally {
        probe.restore();
      }
    });
  },
);

test(
  "warm dispose closes the target, the shared gateway and the history-only service once",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withLazyHost("zcode-lazy-dispose-warm-", async (host) => {
      await warm(host);
      const probe = instrumentCloses(host.targetModelGateway);
      try {
        await host.dispose();
        assert.deepEqual(probe.calls, { target: 1, history: 1, gateway: 1 });
        assertGatewayClosed(host);
        await assert.rejects(host.service.attach({} as never), /agent host service disposed/);
      } finally {
        probe.restore();
      }
    });
  },
);

test(
  "a failing target close reaches the dispose caller unchanged, also on a second dispose",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withLazyHost("zcode-lazy-dispose-propagate-", async (host) => {
      await warm(host);
      const failure = new Error("target close failed");
      const probe = instrumentCloses(host.targetModelGateway, { target: failure });
      try {
        await assert.rejects(host.dispose(), sameError(failure));
        await assert.rejects(host.dispose(), sameError(failure));
      } finally {
        probe.restore();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Repro: a failing close leaks the resources closed after it
// ---------------------------------------------------------------------------

test(
  "a failing target close still closes the shared gateway and the history-only service",
  { timeout: TEST_TIMEOUT_MS, todo: "lazy dispose stops at the first failing close" },
  async () => {
    await withLazyHost("zcode-lazy-dispose-target-fails-", async (host) => {
      await warm(host);
      const failure = new Error("target close failed");
      const probe = instrumentCloses(host.targetModelGateway, { target: failure });
      try {
        await assert.rejects(host.dispose(), sameError(failure));
        assert.deepEqual(probe.calls, { target: 1, history: 1, gateway: 1 });
        assertGatewayClosed(host);
      } finally {
        probe.restore();
      }
    });
  },
);

test(
  "a failing gateway close still closes the history-only service and rejects with the gateway error",
  { timeout: TEST_TIMEOUT_MS, todo: "lazy dispose stops at the first failing close" },
  async () => {
    await withLazyHost("zcode-lazy-dispose-gateway-fails-", async (host) => {
      await warm(host);
      const failure = new Error("gateway close failed");
      const probe = instrumentCloses(host.targetModelGateway, { gateway: failure });
      try {
        await assert.rejects(host.dispose(), sameError(failure));
        assert.deepEqual(probe.calls, { target: 1, history: 1, gateway: 1 });
      } finally {
        probe.restore();
      }
    });
  },
);

test(
  "target and gateway close both failing: the target error wins and history is still closed",
  { timeout: TEST_TIMEOUT_MS, todo: "lazy dispose stops at the first failing close" },
  async () => {
    await withLazyHost("zcode-lazy-dispose-both-fail-", async (host) => {
      await warm(host);
      const primary = new Error("target close failed");
      const secondary = new Error("gateway close failed");
      const probe = instrumentCloses(host.targetModelGateway, {
        target: primary,
        gateway: secondary,
      });
      try {
        await assert.rejects(host.dispose(), sameError(primary));
        assert.deepEqual(probe.calls, { target: 1, history: 1, gateway: 1 });
        assertGatewayClosed(host);
      } finally {
        probe.restore();
      }
    });
  },
);
