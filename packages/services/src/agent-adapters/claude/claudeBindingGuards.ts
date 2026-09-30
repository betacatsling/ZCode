import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { ClaudeFakeModelCompatibilityEvidence } from "./claudeCapabilities.js";

// Binding checks for ClaudeHarnessAdapter (moved verbatim from the adapter class).

/** Adapter state read by validateClaudePlan; evaluated at call time by the adapter. */
export interface ClaudePlanValidationInput {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly hostManagedRoute: string;
  readonly shuttingDown: boolean;
  readonly fakeEvidence:
    | ((selection: ModelSelection) => ClaudeFakeModelCompatibilityEvidence | undefined)
    | undefined;
  readonly isMessagesSelection: (selection: ModelSelection) => boolean;
}

export function validateClaudePlan(
  input: ClaudePlanValidationInput,
  spec: SessionSpec,
  plan: BindingPlan,
): void {
  const selection = plan.effective;
  if (!selection) throw new Error("Claude Model binding is missing its effective selection");
  const evidence = input.fakeEvidence?.(selection);
  if (
    input.shuttingDown ||
    spec.harness.id !== input.adapterId ||
    spec.harness.adapterVersion !== input.adapterVersion ||
    plan.hostSessionId !== spec.hostSessionId ||
    plan.harnessId !== input.adapterId ||
    plan.adapterVersion !== input.adapterVersion ||
    plan.targetId !== spec.execution.targetId ||
    plan.route !== input.hostManagedRoute ||
    plan.support.support !== "supported" ||
    spec.modelBinding.kind !== "host-managed" ||
    JSON.stringify(plan.requested) !== JSON.stringify(spec.modelBinding) ||
    !input.isMessagesSelection(selection) ||
    !evidence ||
    evidence.providerId !== selection.providerId ||
    evidence.modelId !== selection.modelId ||
    plan.support.constraints?.compatibilityEvidence !== "fake-model-fixture" ||
    plan.support.constraints.fixtureId !== evidence.fixtureId
  ) {
    throw new Error(
      "Claude session requires exact pinned FakeModel Messages compatibility evidence",
    );
  }
}

export function validateClaudeModel(plan: BindingPlan, model: Model): void {
  if (
    !plan.effective ||
    model.providerId !== plan.effective.providerId ||
    model.modelId !== plan.effective.modelId ||
    model.options.reasoningLevel !== plan.effective.options?.reasoningLevel ||
    !["low", "medium", "high", "xhigh", "max"].includes(model.options.reasoningLevel ?? "")
  ) {
    throw new Error("Claude Model differs from its captured Messages binding or effort");
  }
}

export function guardClaudeModel(
  model: Model,
  plan: BindingPlan,
  isSelectionAuthorized: (plan: BindingPlan) => boolean,
): Model {
  const assertAuthorized = () => {
    if (!isSelectionAuthorized(plan))
      throw new Error("Claude Model selection is no longer authorized; request refused");
  };
  const guard = (bound: Model): Model => ({
    providerId: bound.providerId,
    modelId: bound.modelId,
    ...(bound.displayName ? { displayName: bound.displayName } : {}),
    properties: bound.properties,
    optionSpecs: bound.optionSpecs,
    options: bound.options,
    bind: (options) => guard(bound.bind(options)),
    generateText: (request) => {
      assertAuthorized();
      return bound.generateText(request);
    },
    streamText: (request) => {
      assertAuthorized();
      return bound.streamText(request);
    },
  });
  return guard(model);
}
