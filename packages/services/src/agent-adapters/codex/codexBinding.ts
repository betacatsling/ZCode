import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { ModelGatewayGrant } from "@zcode/services/model-gateway";

const DISABLED_REASONING_LEVELS = new Set(["off", "none", "disabled"]);

export function reasoningIsDisabled(level: string | undefined): boolean {
  return level !== undefined && DISABLED_REASONING_LEVELS.has(level);
}

export function validateCodexBinding(input: {
  readonly shuttingDown: boolean;
  readonly spec: SessionSpec;
  readonly plan: BindingPlan;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly hostManagedRoute: BindingPlan["route"];
  readonly supportsOpenAiResponses: (selection: ModelSelection) => boolean;
}): void {
  const { spec, plan } = input;
  const fixtureId = plan.support.constraints?.fixtureId;
  const fixtureProviderId = plan.support.constraints?.fixtureProviderId;
  const fixtureModelId = plan.support.constraints?.fixtureModelId;
  const hasFakeModelFixtureEvidence =
    plan.support.constraints?.compatibilityEvidence === "fake-model-fixture" &&
    typeof fixtureId === "string" &&
    fixtureId.trim().length > 0 &&
    typeof fixtureProviderId === "string" &&
    fixtureProviderId === plan.effective?.providerId &&
    typeof fixtureModelId === "string" &&
    fixtureModelId === plan.effective?.modelId;
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
    !hasFakeModelFixtureEvidence ||
    spec.modelBinding.kind !== "host-managed" ||
    JSON.stringify(plan.requested) !== JSON.stringify(spec.modelBinding) ||
    !plan.effective ||
    !input.supportsOpenAiResponses(plan.effective) ||
    !reasoningIsDisabled(plan.effective.options?.reasoningLevel)
  ) {
    throw new Error(
      "Codex adapter requires a pinned host-managed OpenAI Responses binding with reasoning disabled",
    );
  }
}

export function assertCodexGrantMatchesBinding(
  grant: ModelGatewayGrant,
  spec: SessionSpec,
  plan: BindingPlan,
  model: Model,
): void {
  const effective = plan.effective;
  if (
    grant.protocol !== "openai-responses" ||
    grant.sessionId !== spec.hostSessionId ||
    grant.modelBindingFingerprint !== plan.catalogFingerprint ||
    grant.actualModel.providerId !== model.providerId ||
    grant.actualModel.modelId !== model.modelId ||
    !effective ||
    model.providerId !== effective.providerId ||
    model.modelId !== effective.modelId
  ) {
    throw new Error("Model Gateway grant does not match the frozen Codex session binding");
  }
}

export function guardCodexModel(
  model: Model,
  plan: BindingPlan,
  isSelectionAuthorized: (plan: BindingPlan) => boolean,
): Model {
  const assertAuthorized = () => {
    if (!isSelectionAuthorized(plan))
      throw new Error("Codex Model selection is no longer authorized; request refused");
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
