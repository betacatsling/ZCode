import assert from "node:assert/strict";
import test from "node:test";
import type { BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  guardClaudeModel,
  validateClaudeModel,
  validateClaudePlan,
  type ClaudePlanValidationInput,
} from "../src/agent-adapters/claude/claudeBindingGuards.js";
import {
  CLAUDE_UNIT,
  claudeUnitPlan,
  claudeUnitSpec,
  fakeClaudeModel,
} from "./fixtures/claudeUnitFixtures.js";

const PLAN_REFUSAL =
  /Claude session requires exact pinned FakeModel Messages compatibility evidence/;
const MODEL_REFUSAL = /Claude Model differs from its captured Messages binding or effort/;
const REVOKED = /Claude Model selection is no longer authorized; request refused/;

function validInput(overrides: Partial<ClaudePlanValidationInput> = {}): ClaudePlanValidationInput {
  return {
    adapterId: CLAUDE_UNIT.adapterId,
    adapterVersion: CLAUDE_UNIT.adapterVersion,
    hostManagedRoute: CLAUDE_UNIT.route,
    shuttingDown: false,
    fakeEvidence: (selection: ModelSelection) => ({
      providerId: selection.providerId,
      modelId: selection.modelId,
      fixtureId: CLAUDE_UNIT.fixtureId,
    }),
    isMessagesSelection: () => true,
    ...overrides,
  };
}

interface PlanCase {
  readonly name: string;
  readonly mutate: (state: {
    input: ClaudePlanValidationInput;
    spec: SessionSpec;
    plan: BindingPlan;
  }) => ClaudePlanValidationInput | void;
}

function constraints(plan: BindingPlan): Record<string, unknown> {
  return plan.support.constraints as Record<string, unknown>;
}

// One case per term of the `||` chain in validateClaudePlan (claudeBindingGuards.ts:28-46).
const PLAN_CASES: readonly PlanCase[] = [
  { name: "adapter is shutting down", mutate: ({ input }) => ({ ...input, shuttingDown: true }) },
  {
    name: "spec harness id differs",
    mutate: ({ spec }) => {
      (spec.harness as { id: string }).id = "codex";
    },
  },
  {
    name: "spec harness adapterVersion differs",
    mutate: ({ spec }) => {
      (spec.harness as { adapterVersion: string }).adapterVersion = "2.1.262";
    },
  },
  {
    name: "plan hostSessionId differs",
    mutate: ({ plan }) => {
      plan.hostSessionId = "another-session";
    },
  },
  {
    name: "plan harnessId differs",
    mutate: ({ plan }) => {
      plan.harnessId = "codex";
    },
  },
  {
    name: "plan adapterVersion differs",
    mutate: ({ plan }) => {
      plan.adapterVersion = "2.1.262";
    },
  },
  {
    name: "plan targetId differs",
    mutate: ({ plan }) => {
      plan.targetId = "another-target";
    },
  },
  {
    name: "plan route is not messages-gateway",
    mutate: ({ plan }) => {
      plan.route = "responses-gateway";
    },
  },
  {
    name: "plan support is not supported",
    mutate: ({ plan }) => {
      plan.support = { ...plan.support, support: "experimental", reason: "not certified" };
    },
  },
  {
    name: "spec model binding is not host-managed",
    mutate: ({ spec, plan }) => {
      (spec as { modelBinding: unknown }).modelBinding = { kind: "harness-managed" };
      plan.requested = structuredClone(spec.modelBinding);
    },
  },
  {
    name: "plan requested binding differs from the spec",
    mutate: ({ plan }) => {
      plan.requested = {
        kind: "host-managed",
        selection: { ...plan.effective!, options: { reasoningLevel: "high" } },
      };
    },
  },
  {
    name: "selection is not an Anthropic Messages selection",
    mutate: ({ input }) => ({ ...input, isMessagesSelection: () => false }),
  },
  {
    name: "no FakeModel evidence for the selection",
    mutate: ({ input }) => ({ ...input, fakeEvidence: () => undefined }),
  },
  {
    name: "evidence providerId differs",
    mutate: ({ input }) => ({
      ...input,
      fakeEvidence: (selection) => ({
        providerId: "another-provider",
        modelId: selection.modelId,
        fixtureId: CLAUDE_UNIT.fixtureId,
      }),
    }),
  },
  {
    name: "evidence modelId differs",
    mutate: ({ input }) => ({
      ...input,
      fakeEvidence: (selection) => ({
        providerId: selection.providerId,
        modelId: "another-model",
        fixtureId: CLAUDE_UNIT.fixtureId,
      }),
    }),
  },
  {
    name: "plan compatibilityEvidence is not fake-model-fixture",
    mutate: ({ plan }) => {
      constraints(plan).compatibilityEvidence = "live-provider";
    },
  },
  {
    name: "plan fixtureId differs from the evidence",
    mutate: ({ plan }) => {
      constraints(plan).fixtureId = "another-fixture";
    },
  },
];

test("validateClaudePlan accepts the exact pinned FakeModel Messages binding", () => {
  const spec = claudeUnitSpec();
  const seen: ModelSelection[] = [];
  const input = validInput({
    fakeEvidence: (selection) => {
      seen.push(selection);
      return {
        providerId: selection.providerId,
        modelId: selection.modelId,
        fixtureId: CLAUDE_UNIT.fixtureId,
      };
    },
  });
  const plan = claudeUnitPlan(spec);
  assert.doesNotThrow(() => validateClaudePlan(input, spec, plan));
  assert.deepEqual(seen, [plan.effective], "evidence is looked up for the effective selection");
});

for (const current of PLAN_CASES) {
  test(`validateClaudePlan refuses when ${current.name}`, () => {
    const spec = claudeUnitSpec();
    const plan = claudeUnitPlan(spec);
    const input = current.mutate({ input: validInput(), spec, plan }) ?? validInput();
    assert.throws(() => validateClaudePlan(input, spec, plan), PLAN_REFUSAL);
  });
}

test("validateClaudePlan covers all 17 refusal terms", () => {
  assert.equal(PLAN_CASES.length, 17);
});

test("validateClaudePlan refuses a plan without an effective selection before evidence lookup", () => {
  const spec = claudeUnitSpec();
  const plan = claudeUnitPlan(spec);
  delete plan.effective;
  let lookedUp = false;
  const input = validInput({
    fakeEvidence: () => {
      lookedUp = true;
      return undefined;
    },
  });
  assert.throws(
    () => validateClaudePlan(input, spec, plan),
    /Claude Model binding is missing its effective selection/,
  );
  assert.equal(lookedUp, false);
});

test("validateClaudeModel accepts every supported effort that matches the binding", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const spec = claudeUnitSpec();
    const plan = claudeUnitPlan(spec);
    plan.effective = { ...plan.effective!, options: { reasoningLevel: effort as never } };
    assert.doesNotThrow(
      () => validateClaudeModel(plan, fakeClaudeModel({ reasoningLevel: effort })),
      effort,
    );
  }
});

test("validateClaudeModel refuses provider, model and effort drift and unsupported efforts", () => {
  const plan = claudeUnitPlan();
  assert.throws(
    () => validateClaudeModel(plan, fakeClaudeModel({ providerId: "another-provider" })),
    MODEL_REFUSAL,
  );
  assert.throws(
    () => validateClaudeModel(plan, fakeClaudeModel({ modelId: "another-model" })),
    MODEL_REFUSAL,
  );
  assert.throws(
    () => validateClaudeModel(plan, fakeClaudeModel({ reasoningLevel: "high" })),
    MODEL_REFUSAL,
  );
  const off = claudeUnitPlan();
  off.effective = { ...off.effective!, options: { reasoningLevel: "off" as never } };
  assert.throws(
    () => validateClaudeModel(off, fakeClaudeModel({ reasoningLevel: "off" })),
    MODEL_REFUSAL,
    "matching but unsupported effort is still refused",
  );
  const missing = claudeUnitPlan();
  delete missing.effective;
  assert.throws(() => validateClaudeModel(missing, fakeClaudeModel()), MODEL_REFUSAL);
});

test("guardClaudeModel forwards while authorized and refuses every request after revoke", async () => {
  let authorized = true;
  const plan = claudeUnitPlan();
  const checked: BindingPlan[] = [];
  const bound = fakeClaudeModel({ displayName: "Unit Model" });
  const guarded = guardClaudeModel(bound, plan, (current) => {
    checked.push(current);
    return authorized;
  });
  assert.equal(guarded.providerId, bound.providerId);
  assert.equal(guarded.modelId, bound.modelId);
  assert.equal(guarded.displayName, "Unit Model");
  assert.equal(guarded.options, bound.options);
  assert.equal(guarded.optionSpecs, bound.optionSpecs);
  assert.equal(guarded.properties, bound.properties);

  const streamed: unknown[] = [];
  for await (const event of guarded.streamText({ id: "stream-1" } as never)) streamed.push(event);
  assert.deepEqual(streamed, [{ type: "text_delta", text: "streamed" }]);
  assert.deepEqual(await guarded.generateText({ id: "generate-1" } as never), {
    text: "generated",
  });
  assert.deepEqual(
    bound.calls.map((call) => call.kind),
    ["stream", "generate"],
  );
  assert.ok(checked.every((current) => current === plan));

  authorized = false;
  assert.throws(() => guarded.streamText({ id: "stream-2" } as never), REVOKED);
  assert.throws(() => guarded.generateText({ id: "generate-2" } as never), REVOKED);
  assert.equal(bound.calls.length, 2, "a revoked selection never reaches the bound Model");
});

test("guardClaudeModel keeps the guard on rebound Models and omits an absent displayName", () => {
  let authorized = true;
  const bound = fakeClaudeModel();
  const guarded = guardClaudeModel(bound, claudeUnitPlan(), () => authorized);
  assert.equal("displayName" in guarded, false);
  const rebound = guarded.bind({ reasoningLevel: "high" } as never);
  assert.deepEqual(bound.calls[0], { kind: "bind", arg: { reasoningLevel: "high" } });
  assert.equal(rebound.options.reasoningLevel, "high");
  authorized = false;
  assert.throws(() => rebound.streamText({} as never), REVOKED);
  assert.throws(() => rebound.generateText({} as never), REVOKED);
  assert.deepEqual(
    bound.calls.map((call) => call.kind),
    ["bind"],
  );
});
