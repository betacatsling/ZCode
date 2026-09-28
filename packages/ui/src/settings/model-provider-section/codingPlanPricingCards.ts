import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import { CODING_PLAN_PRODUCT_PURCHASE_CARDS_REMOVED } from "@/settings/model-provider-section/codingPlanProductPresentation.js";

// 原生价卡与内嵌官网购买都已下线。forceOAuth 只留在类型里，避免调用方签名断裂，
// 但不能再打开产品登录。

export type CodingPlanLoginOptions = {
  forceOAuth?: boolean;
};

export function shouldOfferCodingPlanOAuthPurchase(_options?: CodingPlanLoginOptions): boolean {
  return !CODING_PLAN_PRODUCT_PURCHASE_CARDS_REMOVED;
}

export function resolveCodingPlanUpgradeProductsProviderId(
  providerId: CodingPlanProviderId,
): CodingPlanProviderId {
  // Start Plan 是免费入口，编程套餐列表应直接展示原 Z.AI Coding Plan 付费套餐。
  // 继续用 Start Plan providerId 会把免费 Start SKU 当成可购买套餐重复展示。
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  // BigModel Start Plan 同样是免费入口，展开升级时必须使用
  // BigModel paid Coding Plan 商品源，不能拿 Start providerId 请求免费 SKU。
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : providerId;
}
