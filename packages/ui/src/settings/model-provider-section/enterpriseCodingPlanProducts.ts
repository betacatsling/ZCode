import type { EnterpriseCodingPlanPricingProduct, ProviderFamilyDomain } from "@zcode/shared";

/**
 * Team Plan 连接/用量所需的已购企业套餐视图。
 * 购买价卡与 pricing 目录映射已随产品获客下线一并卸掉。
 */
export type EnterpriseCodingPlanProductDisplay = {
  productId: string;
  productName: string;
  tier: EnterpriseCodingPlanPricingProduct["tier"];
  subscribeMode: EnterpriseCodingPlanPricingProduct["subscribeMode"];
  subscribePeriod: EnterpriseCodingPlanPricingProduct["subscribePeriod"];
  purchaseMethodName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanPricingProduct["teamProjects"];
  apiKeyStatus?: EnterpriseCodingPlanPricingProduct["apiKeyStatus"];
  apiKeyUnavailableReason?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableReason"];
  apiKeyUnavailableMessage?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableMessage"];
  subscribed?: boolean | null;
  enterpriseProduct: EnterpriseCodingPlanPricingProduct;
  /**
   * 该企业套餐所属的 family（zai / bigmodel）。
   * 缺省 bigmodel 保持向后兼容。
   */
  family?: ProviderFamilyDomain;
};

/** 旧商品缺少 family 时只在这一规范化边界解释为 BigModel。 */
export function resolveEnterpriseCodingPlanProductFamily(
  product: Pick<EnterpriseCodingPlanProductDisplay, "family">,
): ProviderFamilyDomain {
  return product.family ?? "bigmodel";
}
