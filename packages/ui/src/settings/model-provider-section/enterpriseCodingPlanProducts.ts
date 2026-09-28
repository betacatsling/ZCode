import type {
  EnterpriseCodingPlanPricingProduct,
  ProviderFamilyDomain,
} from "@zcode/shared";

/**
 * Team Plan 连接/用量所需的已购企业套餐视图。
 * 购买价卡字段（equity / description / 支付试算）已随产品获客下线一并卸掉。
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

/** 仅从 pricing/customerInfo 映射已购身份；不再合并可购买静态目录。 */
export function resolveEnterpriseCodingPlanProductList(
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  return pricingProducts.map((product) => {
    const purchaseMethodName = product.purchaseMethodName?.trim() ?? "";
    return {
      productId: product.productId,
      productName: formatEnterpriseCodingPlanTier(product.tier),
      tier: product.tier,
      subscribeMode: product.subscribeMode,
      subscribePeriod: product.subscribePeriod,
      purchaseMethodName,
      organizationId: product.organizationId,
      organizationName: product.organizationName,
      projectId: product.projectId,
      projectName: product.projectName,
      teamProjects: product.teamProjects,
      apiKeyStatus: product.apiKeyStatus,
      apiKeyUnavailableReason: product.apiKeyUnavailableReason,
      apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
      subscribed: product.subscribed,
      enterpriseProduct: product,
    };
  });
}

function formatEnterpriseCodingPlanTier(tier: EnterpriseCodingPlanPricingProduct["tier"]): string {
  const normalized = tier.trim();
  if (!normalized) {
    return tier;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}
