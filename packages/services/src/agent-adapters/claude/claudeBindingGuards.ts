import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { AgentErrorCode, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { ModelGatewayGrant } from "@zcode/services/model-gateway";
import type { ClaudeFakeModelCompatibilityEvidence } from "./claudeCapabilities.js";

// Binding checks for ClaudeHarnessAdapter (moved verbatim from the adapter class).

const PLAN_EVIDENCE_REFUSAL =
  "Claude session requires exact pinned FakeModel Messages compatibility evidence";

/**
 * A Claude plan or Gateway grant does not match the session's captured binding, or the plan has
 * no effective selection. Not a catalog reconfigure (ModelBindingReconfigureRequiredError): the
 * selection still exists, so the UI must not prompt for a Provider. `code` matches the receipt
 * reasonCode vocabulary.
 */
export class ClaudeBindingMismatchError extends Error {
  readonly code: Extract<AgentErrorCode, "invalid-binding"> = "invalid-binding";

  constructor(
    readonly mismatch: "plan-evidence" | "grant" | "missing-effective",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeBindingMismatchError";
  }
}

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
  if (!selection)
    throw new ClaudeBindingMismatchError(
      "missing-effective",
      "Claude Model binding is missing its effective selection",
    );
  // Shutdown is adapter state, not a binding mismatch: same message, untyped.
  if (input.shuttingDown) throw new Error(PLAN_EVIDENCE_REFUSAL);
  const evidence = input.fakeEvidence?.(selection);
  if (
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
    plan.support.constraints.fixtureId !== evidence.fixtureId ||
    plan.support.constraints.fixtureProviderId !== selection.providerId ||
    plan.support.constraints.fixtureModelId !== selection.modelId
  ) {
    throw new ClaudeBindingMismatchError("plan-evidence", PLAN_EVIDENCE_REFUSAL);
  }
}

/** The Gateway grant must carry exactly the session's captured Messages binding. */
export function assertClaudeGrantMatchesBinding(
  grant: ModelGatewayGrant,
  spec: SessionSpec,
  plan: BindingPlan,
  publicModelId: string,
): void {
  if (
    grant.protocol !== "anthropic-messages" ||
    grant.sessionId !== spec.hostSessionId ||
    grant.modelBindingFingerprint !== plan.catalogFingerprint ||
    grant.publicModelId !== publicModelId ||
    grant.actualModel.providerId !== plan.effective?.providerId ||
    grant.actualModel.modelId !== plan.effective?.modelId
  ) {
    throw new ClaudeBindingMismatchError(
      "grant",
      "Claude Gateway grant differs from the captured binding",
    );
  }
}

/** Returns the validated effort; startup passes it to the session profile. */
export function validateClaudeModel(plan: BindingPlan, model: Model): string {
  const effort = model.options.reasoningLevel;
  if (
    !plan.effective ||
    model.providerId !== plan.effective.providerId ||
    model.modelId !== plan.effective.modelId ||
    effort !== plan.effective.options?.reasoningLevel ||
    !effort ||
    !["low", "medium", "high", "xhigh", "max"].includes(effort)
  ) {
    throw new Error("Claude Model differs from its captured Messages binding or effort");
  }
  return effort;
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
