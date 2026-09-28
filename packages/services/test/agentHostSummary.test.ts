import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

test("Host directory and summaries expose live facts without cold worker startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-agent-host-summary-"));
  const worktreePath = join(root, "worktree");
  await mkdir(worktreePath);
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "summary-session",
    execution: { targetId: "target", workspaceIdentity: "workspace", worktreePath },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } },
  };
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.register(mock);
  const createTarget = (currentRegistry: HarnessRegistry) =>
    new AgentHostTargetService({
      root: join(root, "host"),
      target: {
        id: "target",
        kind: "local",
        platform: process.platform as "darwin" | "linux",
        available: true,
      },
      catalog: { fingerprint: "summary-v1", validateSelection: () => ({ ok: true as const }) },
      registry: currentRegistry,
      authorizeWorktree: async () => true,
    });
  const target = createTarget(registry);
  try {
    const directory = await target.getDirectory();
    assert.equal(directory.get("zcode")?.manifest.name, "ZCode");
    assert.equal(directory.get("mock"), undefined);
    assert.equal(directory.get("pi")?.status, "unavailable");

    await target.create(spec);
    const idle = await target.listSessionSummaries("workspace", worktreePath);
    assert.equal(idle[0]?.freshness, "live");
    assert.equal(idle[0]?.lastKnownStatus, "idle");
    assert.equal(idle[0]?.recentOutcome, "none");

    await target.dispatch(spec, {
      type: "send",
      commandId: "summary-send",
      hostSessionId: spec.hostSessionId,
      turnId: "summary-turn",
      text: "inspect",
    });
    await mock.waitForInteraction(spec.hostSessionId);
    await target.snapshot(spec);
    const waiting = await target.listSessionSummaries("workspace", worktreePath);
    assert.equal(waiting[0]?.lastKnownStatus, "waiting");
    assert.equal(waiting[0]?.pendingInteractionCount, 1);

    const snapshot = await target.snapshot(spec);
    await target.dispatch(spec, {
      type: "resolveInteraction",
      commandId: "summary-deny",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: snapshot.logEpoch,
      turnId: "summary-turn",
      interactionId: "approval-1",
      decision: "deny",
    });
    await target.waitForIdle(spec);
    const completed = await target.listSessionSummaries("workspace", worktreePath);
    assert.equal(completed[0]?.lastKnownStatus, "completed");
    assert.equal(completed[0]?.recentOutcome, "success");

    await target.close();
    const coldTarget = createTarget(new HarnessRegistry());
    try {
      const cold = await coldTarget.listSessionSummaries("workspace", worktreePath);
      assert.equal(cold[0]?.freshness, "stale");
      assert.equal(cold[0]?.lastKnownStatus, "unknown");
      assert.equal(cold[0]?.recentOutcome, "unknown");
    } finally {
      await coldTarget.close();
    }
  } finally {
    try {
      const active = await target.snapshot(spec);
      const turnId = active.control.activeWorks[0]?.foregroundExecutionId;
      if (turnId) {
        await target.dispatch(spec, {
          type: "cancelTurn",
          commandId: "summary-cleanup-cancel",
          hostSessionId: spec.hostSessionId,
          runtimeEpoch: active.logEpoch,
          turnId,
        });
      }
    } catch {
      // Keep cleanup best effort; the test assertion remains the reported failure.
    }
    await target.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
