import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BindingPlan, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import { TargetModelGateway } from "../src/model-gateway/index.js";
import { claudeHarnessCapabilities } from "../src/agent-adapters/claude/claudeCapabilities.js";
import { PINNED_CLAUDE_CLI_VERSION } from "../src/agent-adapters/claude/claudeExecutable.js";
import {
  ClaudeHarnessAdapter,
  type ClaudeHarnessAdapterOptions,
} from "../src/agent-adapters/claude/claudeHarnessAdapter.js";
import {
  CLAUDE_UNIT,
  claudeUnitPlan,
  claudeUnitSpec,
  fakeClaudeModel,
} from "./fixtures/claudeUnitFixtures.js";

const NOT_ATTACHED = /Claude Host session is not attached/;

async function withAdapter(
  t: test.TestContext,
  options: Partial<ClaudeHarnessAdapterOptions> = {},
): Promise<{ adapter: ClaudeHarnessAdapter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-delegation-"));
  const adapter = new ClaudeHarnessAdapter({
    root,
    executablePath: join(root, "missing-claude"),
    modelFactory: () => fakeClaudeModel(),
    isMessagesSelection: () => true,
    fakeModelCompatibilityEvidence: (selection) => ({
      providerId: selection.providerId,
      modelId: selection.modelId,
      fixtureId: CLAUDE_UNIT.fixtureId,
    }),
    ...options,
  });
  t.after(async () => {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { adapter, root };
}

function unitSpecForAdapter(): SessionSpec {
  const spec = claudeUnitSpec();
  (spec.harness as { adapterVersion: string }).adapterVersion = PINNED_CLAUDE_CLI_VERSION;
  return spec;
}

function unitPlanForAdapter(spec: SessionSpec): BindingPlan {
  return { ...claudeUnitPlan(spec), adapterVersion: PINNED_CLAUDE_CLI_VERSION };
}

test("adapter identity and harness-managed support stay pinned and unsupported", async (t) => {
  const { adapter } = await withAdapter(t);
  assert.equal(adapter.id, "claude-code");
  assert.equal(adapter.version, PINNED_CLAUDE_CLI_VERSION);
  assert.equal(adapter.hostManagedRoute, "messages-gateway");
  assert.deepEqual(await adapter.harnessManagedSupport(), {
    support: "unsupported",
    reason: "Native Claude account or subscription authentication is not enabled",
  });
  const target = { id: "t", kind: "local", platform: process.platform, available: true };
  assert.deepEqual(
    await adapter.capabilities(target as ExecutionTarget),
    claudeHarnessCapabilities(),
  );
});

test("probe and hostManagedSupport delegate the target and configured executable", async (t) => {
  const { adapter } = await withAdapter(t);
  const unavailable = {
    id: "t",
    kind: "local",
    platform: process.platform,
    available: false,
    reason: "offline",
  } as ExecutionTarget;
  assert.deepEqual(await adapter.probe(unavailable), { support: "unsupported", reason: "offline" });
  const local = { id: "t", kind: "local", platform: process.platform, available: true };
  const probe = await adapter.probe(local as ExecutionTarget);
  assert.equal(probe.support, "unsupported", "the configured executable path does not exist");
  assert.match(probe.reason ?? "", /Pinned Claude Code CLI is unavailable/);
  const support = await adapter.hostManagedSupport(
    local as ExecutionTarget,
    claudeUnitPlan().effective!,
  );
  assert.deepEqual(support, probe, "hostManagedSupport stops at the same target probe");
});

test("prepareModel returns the modelFactory result for the exact spec and plan", async (t) => {
  const model = fakeClaudeModel();
  const seen: unknown[] = [];
  const { adapter } = await withAdapter(t, {
    modelFactory: (spec, plan) => {
      seen.push(spec, plan);
      return model;
    },
  });
  const spec = unitSpecForAdapter();
  const plan = unitPlanForAdapter(spec);
  assert.equal(await adapter.prepareModel(spec, plan), model);
  assert.deepEqual(seen, [spec, plan]);
  assert.equal(seen[0], spec);
  assert.equal(seen[1], plan);
});

test("session-scoped commands refuse a session that is not attached", async (t) => {
  const { adapter } = await withAdapter(t);
  const spec = unitSpecForAdapter();
  const plan = unitPlanForAdapter(spec);
  const prepared = { plan, model: fakeClaudeModel(), turnId: "turn-1" };
  await assert.rejects(adapter.prepareTurn(spec, prepared), NOT_ATTACHED);
  await assert.rejects(adapter.discardPreparedTurn(spec, prepared), NOT_ATTACHED);
  assert.throws(() => adapter.renewTurnLease(spec.hostSessionId, "turn-1"), NOT_ATTACHED);
  await assert.rejects(
    adapter.send(
      {
        type: "send",
        commandId: "send-1",
        hostSessionId: spec.hostSessionId,
        turnId: "turn-1",
        text: "hello",
      },
      prepared,
    ),
    NOT_ATTACHED,
  );
  await assert.rejects(
    adapter.cancelTurn({
      type: "cancelTurn",
      commandId: "cancel-1",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: "epoch",
      turnId: "turn-1",
    }),
    NOT_ATTACHED,
  );
  await assert.rejects(
    adapter.resolveInteraction({
      type: "resolveInteraction",
      commandId: "resolve-1",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: "epoch",
      turnId: "turn-1",
      interactionId: "interaction-1",
      decision: "allow",
    }),
    NOT_ATTACHED,
  );
});

test("discarding a prepared binding without a turn and terminating an unknown session are no-ops", async (t) => {
  const { adapter } = await withAdapter(t);
  const spec = unitSpecForAdapter();
  const plan = unitPlanForAdapter(spec);
  await adapter.discardPreparedTurn(spec, { plan });
  await adapter.terminate("never-attached");
});

test("subscribe returns an idempotent unsubscribe", async (t) => {
  const { adapter } = await withAdapter(t);
  const unsubscribeA = adapter.subscribe("session-x", () => undefined);
  const unsubscribeB = adapter.subscribe("session-x", () => undefined);
  unsubscribeA();
  unsubscribeA();
  unsubscribeB();
  unsubscribeB();
});

test("shutdown is idempotent, refuses new starts, and leaves an injected Target Gateway open", async (t) => {
  const targetModelGateway = new TargetModelGateway();
  t.after(() => targetModelGateway.close());
  const { adapter } = await withAdapter(t, { targetModelGateway });
  const spec = unitSpecForAdapter();
  const plan = unitPlanForAdapter(spec);

  // Before shutdown the plan is accepted and startup proceeds to executable discovery.
  await assert.rejects(
    adapter.create(spec, plan),
    /Claude Code executable was not found in the explicit path or PATH/,
  );

  // Concurrent and repeated shutdown calls settle on the same in-flight shutdown.
  await Promise.all([adapter.shutdown(), adapter.shutdown()]);
  await adapter.shutdown();

  // The startup context reads the shutdown flag at call time, so the same plan is now refused.
  await assert.rejects(
    adapter.create(spec, plan),
    /Claude session requires exact pinned FakeModel Messages compatibility evidence/,
  );
  await assert.rejects(
    adapter.attach(
      spec,
      {
        hostSessionId: spec.hostSessionId,
        backendSessionId: "native",
        backendVersion: PINNED_CLAUDE_CLI_VERSION,
        runtimeEpoch: "epoch",
      },
      0,
      plan,
    ),
    /Claude target host is shutting down/,
  );
  assert.doesNotThrow(
    () => targetModelGateway.get(spec.execution.targetId),
    "the adapter only closes a Target Gateway it created",
  );
});
