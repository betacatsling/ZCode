import { createHash } from "node:crypto";
import type { Model } from "@zcode/contracts";
import type { ProviderRegistryService } from "@zcode/provider";
import type { BindingPlan } from "@zcode/shared/agent-host";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";

export interface CapturedHostModel {
  model: Model;
  identity?: {
    providerId: string;
    modelId: string;
    apiType: string;
    endpointFingerprint: string;
  };
}

/** Public, narrow Node boundary to the existing CLI model executor; no second HTTP client. */
export function captureHostModel(input: {
  plan: BindingPlan;
  registry: Pick<
    ProviderRegistryService,
    "getSnapshot" | "validateSelection" | "getProvider" | "getModel"
  >;
  adapter: Pick<AiSdkModelAdapter, "createModel">;
}): CapturedHostModel {
  const { plan, registry, adapter } = input;
  if (
    plan.support.support !== "supported" ||
    plan.requested.kind !== "host-managed" ||
    !plan.effective ||
    !plan.route ||
    plan.route === "harness-managed"
  ) {
    throw new Error("host-managed binding not certified");
  }
  const effective = plan.effective;
  const requested = plan.requested.selection;
  if (JSON.stringify(effective) !== JSON.stringify(requested))
    throw new Error("requested/effective model mismatch");
  const snapshot = registry.getSnapshot();
  if (!snapshot || JSON.stringify(snapshot.sourceRevisions) !== plan.catalogFingerprint)
    throw new Error("model catalog changed since binding plan; replan next turn");
  const validation = registry.validateSelection(effective);
  if (!validation.ok) throw new Error(`invalid model binding: ${validation.code}`);
  const provider = registry.getProvider(effective.providerId);
  const model = registry.getModel(effective.providerId, effective.modelId);
  if (!provider || !model || !effective.options?.reasoningLevel)
    throw new Error("model binding incomplete");
  if (
    provider.config.access.type === "zhipu-account" &&
    provider.config.access.mode === "off-peak"
  ) {
    throw new Error(
      "off-peak account auth needs a target-host requestAuth source; model binding not certified",
    );
  }
  const bound = adapter.createModel({
    providerId: provider.providerId,
    modelId: model.modelId,
    providerConfig: provider.config,
    modelConfig: model.config,
    options: { reasoningLevel: effective.options.reasoningLevel },
  });
  if (bound.providerId !== effective.providerId || bound.modelId !== effective.modelId)
    throw new Error("model executor returned different route");
  // 修复：只对 SDK 实际收到的显式端点建立签名身份；SDK 默认 URL 不在本契约内，
  // 普通未签名请求仍可走原有模型，Pi 收到签名时则会拒绝缺失身份的路由。
  const api = provider.config.api;
  if (!api?.type || !api.baseUrl) return { model: bound };
  return {
    model: bound,
    identity: {
      providerId: bound.providerId,
      modelId: bound.modelId,
      apiType: api.type,
      endpointFingerprint: createHash("sha256").update(api.baseUrl).digest("hex"),
    },
  };
}

export function bindHostModel(input: Parameters<typeof captureHostModel>[0]): Model {
  return captureHostModel(input).model;
}
