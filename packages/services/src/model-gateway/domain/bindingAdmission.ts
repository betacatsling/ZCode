import { bindingPlanSchema, hostSessionCacheKey, type BindingPlan } from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ModelGatewayProtocol } from "../contract.js";

const DISABLED_RESPONSES_REASONING = new Set(["none", "off", "disabled"]);

const ROUTE_BY_PROTOCOL = {
  "openai-responses": "responses-gateway",
  "anthropic-messages": "messages-gateway",
} as const;

export function admitHostManagedGrant(input: {
  readonly protocol: ModelGatewayProtocol;
  readonly sessionId: string;
  readonly modelBindingFingerprint: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly reasoningLevel?: string;
  readonly plan?: BindingPlan;
}): void {
  requireHostSessionId(input.sessionId);
  if (!input.plan) return;
  const parsed = bindingPlanSchema.safeParse(input.plan);
  if (!parsed.success) throw new Error("BindingPlan is invalid");
  const plan = parsed.data;
  if (plan.hostSessionId !== input.sessionId) {
    throw new Error("BindingPlan hostSessionId does not match the grant");
  }
  if (plan.route !== ROUTE_BY_PROTOCOL[input.protocol]) {
    throw new Error("BindingPlan route does not match the Gateway protocol");
  }
  if (plan.catalogFingerprint !== input.modelBindingFingerprint) {
    throw new Error("BindingPlan catalog fingerprint does not match the grant");
  }
  if (
    plan.requested.kind !== "host-managed" ||
    plan.support.support !== "supported" ||
    !plan.effective
  ) {
    throw new Error("BindingPlan requires a supported host-managed model");
  }
  if (!sameSelection(plan.requested.selection, plan.effective)) {
    throw new Error("requested/effective model mismatch");
  }
  if (plan.effective.providerId !== input.providerId || plan.effective.modelId !== input.modelId) {
    throw new Error("BindingPlan model does not match the bound Model");
  }
  const planReasoning = plan.effective.options?.reasoningLevel;
  if (
    input.protocol === "openai-responses" &&
    (!planReasoning || !DISABLED_RESPONSES_REASONING.has(planReasoning))
  ) {
    throw new Error("BindingPlan reasoning parameter is not admitted by the Responses slice");
  }
  if (planReasoning !== input.reasoningLevel) {
    throw new Error("BindingPlan reasoning parameter does not match the bound Model");
  }
}

function requireHostSessionId(sessionId: string): void {
  let parsed: string;
  try {
    parsed = hostSessionCacheKey({ hostSessionId: sessionId });
  } catch {
    throw new Error("sessionId must be a hostSessionId");
  }
  if (parsed !== sessionId) throw new Error("sessionId must be a hostSessionId");
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}
