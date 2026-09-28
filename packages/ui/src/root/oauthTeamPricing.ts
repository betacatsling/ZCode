import type { IServiceAccessor } from "@zcode/services";
import type { EnterpriseCodingPlanPricingProduct, ProviderFamilyDomain } from "@zcode/shared";

type EnterprisePricingProductsResult =
  | { status: "success"; productList: EnterpriseCodingPlanPricingProduct[] }
  | { status: "error" };

export async function getEnterprisePricingProducts(
  services: IServiceAccessor,
  domain: ProviderFamilyDomain,
): Promise<EnterprisePricingProductsResult> {
  // 两个账号域均须按自身 Family 查询；失败与明确空列表分开，不能据此自动改掉已有连接。
  // 产品订阅服务已拆除。登录后不再查询团队定价，按空列表收敛。
  void services;
  void domain;
  return { status: "success", productList: [] };
}

export async function getEnterprisePricingProductsOrEmpty(
  services: IServiceAccessor,
  domain: ProviderFamilyDomain,
): Promise<EnterpriseCodingPlanPricingProduct[]> {
  const pricing = await getEnterprisePricingProducts(services, domain);
  return pricing.status === "success" ? pricing.productList : [];
}
