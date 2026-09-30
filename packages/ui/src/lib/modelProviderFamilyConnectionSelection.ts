import type { ProviderFamilyConnectionSelection, ProviderFamilyDomain } from "@zcode/shared";
import { getModelProviderFamilySpec } from "@zcode/shared";

export type ModelProviderFamilyConnectionSelection = ProviderFamilyConnectionSelection;

/** 把当前 Family 连接意图映射为对应的 Built-in Account Provider 身份。 */
export function resolveModelProviderFamilyConnectionProviderId(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  selection: ProviderFamilyConnectionSelection;
}): string {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);
  switch (params.selection.kind) {
    case "start-plan":
      return familySpec.startPlanProviderId;
    case "individual-coding-plan":
      return familySpec.individualCodingPlanProviderId;
    case "team-coding-plan":
      return familySpec.teamCodingPlanProviderId;
  }
}
