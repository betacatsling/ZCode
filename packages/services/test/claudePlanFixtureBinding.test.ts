import assert from "node:assert/strict";
import test from "node:test";
import type { BindingPlan } from "@zcode/shared/agent-host";
import {
  validateClaudePlan,
  type ClaudePlanValidationInput,
} from "../src/agent-adapters/claude/claudeBindingGuards.js";
import { claudeAdapterHarness, listeningServers } from "./fixtures/claudeAdapterHarness.js";
import { CLAUDE_UNIT, claudeUnitPlan, claudeUnitSpec } from "./fixtures/claudeUnitFixtures.js";

// A15: the plan's pinned fixture Provider/model must equal the effective selection, as
// validateBinding already requires per turn (claudeTurnLifecycle.ts:163-168). Evidence refusals
// are typed `invalid-binding`; a shutdown refusal is not a binding problem and stays untyped.

const PLAN_REFUSAL =
  "Claude session requires exact pinned FakeModel Messages compatibility evidence";

const input: ClaudePlanValidationInput = {
  adapterId: CLAUDE_UNIT.adapterId,
  adapterVersion: CLAUDE_UNIT.adapterVersion,
  hostManagedRoute: CLAUDE_UNIT.route,
  shuttingDown: false,
  fakeEvidence: (selection) => ({
    providerId: selection.providerId,
    modelId: selection.modelId,
    fixtureId: CLAUDE_UNIT.fixtureId,
  }),
  isMessagesSelection: () => true,
};

function constraints(plan: BindingPlan): Record<string, unknown> {
  return plan.support.constraints as Record<string, unknown>;
}

function planEvidenceMismatch(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ClaudeBindingMismatchError");
  assert.equal(error.message, PLAN_REFUSAL);
  const typed = error as Error & { code?: unknown; mismatch?: unknown };
  assert.equal(typed.code, "invalid-binding");
  assert.equal(typed.mismatch, "plan-evidence");
  return true;
}

const FIXTURE_CASES: readonly { name: string; mutate: (plan: BindingPlan) => void }[] = [
  {
    name: "fixtureProviderId differs",
    mutate: (p) => void (constraints(p).fixtureProviderId = "x"),
  },
  { name: "fixtureModelId differs", mutate: (p) => void (constraints(p).fixtureModelId = "x") },
  {
    name: "fixtureProviderId is absent",
    mutate: (p) => void delete constraints(p).fixtureProviderId,
  },
  { name: "fixtureModelId is absent", mutate: (p) => void delete constraints(p).fixtureModelId },
];

for (const current of FIXTURE_CASES) {
  test(
    `validateClaudePlan refuses with a typed error when ${current.name}`,
    { todo: "A15" },
    () => {
      const spec = claudeUnitSpec();
      const plan = claudeUnitPlan(spec);
      current.mutate(plan);
      assert.throws(() => validateClaudePlan(input, spec, plan), planEvidenceMismatch);
    },
  );
}

test(
  "validateClaudePlan types the existing evidence refusals as invalid-binding",
  { todo: "A15" },
  () => {
    const spec = claudeUnitSpec();
    const plan = claudeUnitPlan(spec);
    constraints(plan).fixtureId = "another-fixture";
    assert.throws(() => validateClaudePlan(input, spec, plan), planEvidenceMismatch);
    assert.throws(
      () =>
        validateClaudePlan({ ...input, fakeEvidence: () => undefined }, spec, claudeUnitPlan(spec)),
      planEvidenceMismatch,
    );
  },
);

test("validateClaudePlan keeps the shutdown refusal an untyped Error with the same message", () => {
  const spec = claudeUnitSpec();
  const plan = claudeUnitPlan(spec);
  assert.throws(
    () => validateClaudePlan({ ...input, shuttingDown: true }, spec, plan),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "Error");
      assert.equal(error.message, PLAN_REFUSAL);
      assert.equal((error as { code?: unknown }).code, undefined);
      return true;
    },
  );
});

test(
  "create refuses a fixture-mismatched plan before any grant, server or launch",
  { todo: "A15" },
  async (t) => {
    const h = await claudeAdapterHarness(t);
    const servers = await listeningServers();
    const plan = claudeUnitPlan(h.spec);
    constraints(plan).fixtureModelId = "another-model";
    await assert.rejects(h.adapter.create(h.spec, plan), planEvidenceMismatch);
    assert.deepEqual(h.grants.created, []);
    assert.equal(h.launches.length, 0);
    assert.equal(await listeningServers(), servers);
    await h.adapter.create(h.spec, h.plan);
    assert.equal(h.grants.created.length, 1, "the matching plan still starts");
  },
);
