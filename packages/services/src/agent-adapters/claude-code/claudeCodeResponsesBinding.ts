import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { BindingPlan, CapabilityReport, SessionSpec } from "@zcode/shared/agent-host";

const DISABLED_RESPONSES_REASONING = new Set(["none", "off", "disabled"]);

/**
 * 没有 factory 时不能把端口证据当成 Responses 已接通。
 * factory 只负责把计划交给现有 Model runtime，真正的 streamText 由 Gateway 调用。
 */
export function prepareClaudeCodeResponsesModel(input: {
  readonly spec: SessionSpec;
  readonly plan: BindingPlan;
  readonly route: BindingPlan["route"];
  readonly modelFactory:
    | ((spec: SessionSpec, plan: BindingPlan) => Promise<Model> | Model)
    | undefined;
}): Promise<Model> | Model {
  if (!input.modelFactory) {
    throw new Error("Claude Code model factory is not configured");
  }
  if (
    input.plan.requested.kind !== "host-managed" ||
    input.plan.route !== input.route ||
    input.plan.support.support !== "supported" ||
    !input.plan.effective
  ) {
    throw new Error("Claude Code prepareModel requires a supported messages-gateway plan");
  }
  return input.modelFactory(input.spec, input.plan);
}

export function claudeCodeResponsesSupport(input: {
  readonly probed: CapabilityReport;
  readonly selection: ModelSelection;
  readonly route: "messages-gateway";
}): CapabilityReport {
  if (input.probed.support !== "supported") return input.probed;
  const reasoning = input.selection.options?.reasoningLevel;
  if (!reasoning || !DISABLED_RESPONSES_REASONING.has(reasoning)) {
    return {
      support: "unsupported",
      reason: "Claude Code Responses admission requires reasoning to be disabled",
    };
  }
  return {
    support: "supported",
    reason:
      "Selection is admitted to the existing model runtime. This does not certify a live Provider.",
    constraints: {
      route: input.route,
      execution: "existing-model-runtime",
      reachedModelExecutionLayer: false,
    },
  };
}
