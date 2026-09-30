import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import { TargetModelGateway } from "@zcode/services/model-gateway";
import { createExperimentalRegistryClaudeHarness } from "../src/agent-adapters/claude/createClaudeHarness.js";
import type { HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";
import { fakeClaudeLauncher } from "./fixtures/claudeFakeProcess.js";
import {
  CLAUDE_UNIT,
  claudeUnitPlan,
  claudeUnitSpec,
  fakeClaudeModel,
} from "./fixtures/claudeUnitFixtures.js";

// C3: the lazy Host owns ONE TargetModelGateway per target Core and injects it into every
// Gateway-backed harness. Codex already receives it; Claude must too (no private owner).
// Pi and Devin bind no Gateway at all.

const localTarget: ExecutionTarget = {
  id: "local-core-1",
  kind: "local",
  platform: process.platform as ExecutionTarget["platform"],
  available: true,
};

function registry(apiType = "anthropic-messages"): ProviderRegistryService {
  return {
    start: async () => undefined,
    getProvider: () => ({ config: { api: { type: apiType } } }),
    validateSelection: () => ({ ok: true }),
  } as unknown as ProviderRegistryService;
}

/** Codex and Claude both expose the Gateway owner they were bound to. */
function gatewayOf(harness: HarnessAdapter | undefined): unknown {
  return (harness as unknown as { boundTargetGateway(): unknown }).boundTargetGateway();
}

function trackGatewayCloses(t: test.TestContext): Map<object, number> {
  const closes = new Map<object, number>();
  const original = TargetModelGateway.prototype.close;
  TargetModelGateway.prototype.close = async function (this: TargetModelGateway) {
    closes.set(this, (closes.get(this) ?? 0) + 1);
    return original.call(this);
  };
  t.after(() => {
    TargetModelGateway.prototype.close = original;
  });
  return closes;
}

test("lazy Host injects its one shared Gateway into Claude, like Codex", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-c3-lazy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const closes = trackGatewayCloses(t);
  const harnesses = new Map<string, HarnessAdapter>();
  const host = createLazyTargetAgentHostService({
    root,
    target: localTarget,
    registry: registry(),
    allowNewSessions: () => true,
    observeRegisteredHarness: (harness) => harnesses.set(harness.id, harness),
  });
  await host.service.getWorkspaceSessionCapability({
    harnessId: "claude-code",
    modelBinding: { kind: "harness-managed" },
  });
  assert.deepEqual([...harnesses.keys()], ["pi", "codex", "claude-code", "devin"]);
  await host.dispose();
  // Only the shared owner exists and only dispose closes it; Claude built no private owner.
  assert.deepEqual([...closes.entries()], [[host.targetModelGateway, 1]]);
  assert.equal(gatewayOf(harnesses.get("claude-code")), host.targetModelGateway);
  // Control: Codex keeps the shared owner; Pi and Devin still bind no Gateway.
  assert.equal(gatewayOf(harnesses.get("codex")), host.targetModelGateway);
  assert.equal("boundTargetGateway" in harnesses.get("pi")!, false);
  assert.equal("boundTargetGateway" in harnesses.get("devin")!, false);
});

test("Claude built with the shared Gateway creates its grant there and never closes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-c3-factory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = new TargetModelGateway();
  t.after(() => shared.close());
  const gateway = shared.get(CLAUDE_UNIT.targetId);
  const grants: string[] = [];
  const createGrant = gateway.createGrant.bind(gateway);
  gateway.createGrant = (input) => {
    const grant = createGrant(input);
    grants.push(grant.id);
    return grant;
  };
  const { launchProcess, launches } = fakeClaudeLauncher();
  const claude = createExperimentalRegistryClaudeHarness({
    root,
    registry: registry(),
    targetModelGateway: shared,
    launchProcess,
    fakeModelCompatibilityEvidence: () => ({
      providerId: CLAUDE_UNIT.providerId,
      modelId: CLAUDE_UNIT.modelId,
      fixtureId: CLAUDE_UNIT.fixtureId,
    }),
  });
  await mkdir(join(root, "workspace"));
  const unit = claudeUnitSpec();
  const spec: SessionSpec = {
    ...unit,
    execution: { ...unit.execution, worktreePath: join(root, "workspace") },
  };
  const plan = claudeUnitPlan(spec);

  await claude.create(spec, plan, { plan, model: fakeClaudeModel() });
  assert.equal(grants.length, 1, "the grant is created on the injected shared Gateway");
  assert.equal(launches.length, 1);
  assert.equal(gatewayOf(claude), shared);
  await claude.shutdown();
  assert.equal(shared.get(CLAUDE_UNIT.targetId), gateway, "Claude shutdown leaves it open");
});

test("Claude without an injected Gateway keeps a private owner and closes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-c3-owned-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const closes = trackGatewayCloses(t);
  const claude = createExperimentalRegistryClaudeHarness({ root, registry: registry() });
  const owned = gatewayOf(claude);
  assert.ok(owned instanceof TargetModelGateway);
  await claude.shutdown();
  assert.deepEqual([...closes.entries()], [[owned, 1]]);
});
