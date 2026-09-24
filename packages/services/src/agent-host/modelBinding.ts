import type { Model } from "@zcode/contracts";
import type { ProviderRegistryService } from "@zcode/provider";
import type { BindingPlan } from "@zcode/shared/agent-host";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";

/** Public, narrow Node boundary to the existing CLI model executor; no second HTTP client. */
export function bindHostModel(input: {
  plan: BindingPlan;
  registry: Pick<ProviderRegistryService, "getSnapshot" | "validateSelection" | "getProvider" | "getModel">;
  adapter: Pick<AiSdkModelAdapter, "createModel">;
}): Model {
  const { plan, registry, adapter } = input;
  if (plan.support.support !== "supported" || plan.requested.kind !== "host-managed" || !plan.effective || !plan.route || plan.route === "harness-managed") {
    throw new Error("host-managed binding not certified");
  }
  const effective = plan.effective;
  const requested = plan.requested.selection;
  if (JSON.stringify(effective) !== JSON.stringify(requested)) throw new Error("requested/effective model mismatch");
  const snapshot = registry.getSnapshot();
  if (!snapshot || JSON.stringify(snapshot.sourceRevisions) !== plan.catalogFingerprint) throw new Error("model catalog changed since binding plan; replan next turn");
  const validation = registry.validateSelection(effective);
  if (!validation.ok) throw new Error(`invalid model binding: ${validation.code}`);
  const provider = registry.getProvider(effective.providerId);
  const model = registry.getModel(effective.providerId, effective.modelId);
  if (!provider || !model || !effective.options?.reasoningLevel) throw new Error("model binding incomplete");
  if (provider.config.access.type === "zhipu-account" && provider.config.access.mode === "off-peak") {
    throw new Error("off-peak account auth needs a target-host requestAuth source; model binding not certified");
  }
  const bound = adapter.createModel({
    providerId: provider.providerId,
    modelId: model.modelId,
    providerConfig: provider.config,
    modelConfig: model.config,
    options: { reasoningLevel: effective.options.reasoningLevel },
  });
  if (bound.providerId !== effective.providerId || bound.modelId !== effective.modelId) throw new Error("model executor returned different route");
  return bound;
}
