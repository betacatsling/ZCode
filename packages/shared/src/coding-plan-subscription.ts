/* eslint-disable max-lines -- Coding Plan 订阅协议类型需要集中导出给 UI、services 和 RPC 共享，拆散会增加跨包类型入口复杂度。 */
import type { BUILTIN_MODEL_PROVIDER_IDS } from "./model-provider-types.js";

export type CodingPlanSubscriptionProviderId =
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan
  | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
export const CODING_PLAN_SYSTEM_BUSY = "coding_plan_system_busy" as const;

export type CodingPlanUnavailableReason = "not_authenticated" | "request_failed";

export interface CodingPlanStaticProductEquity {
  productEquityTitle: string;
  productEquityDetails?: string;
}

export interface CodingPlanCardCopyItem {
  text: string;
  tooltip?: string;
}

export type CodingPlanCardCopyConfigItem = string | CodingPlanCardCopyItem;

export interface CodingPlanStaticProduct {
  productId: string;
  productName: string;
  productSmallTitle?: string;
  equity?: CodingPlanCardCopyConfigItem[];
  description?: string | CodingPlanCardCopyConfigItem[];
  productEquityList?: CodingPlanStaticProductEquity[];
  priceUnit: "month" | "quarter" | "year";
  displayOrder: number;
  priceCurrency: "CNY" | "USD";
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  monthlyOriginalAmount?: number;
  monthlyRenewAmount?: number;
  monthlyPayAmount?: number;
  renewAmount?: number;
}

export type CodingPlanStaticProductsConfig = Partial<
  Record<CodingPlanSubscriptionProviderId, CodingPlanStaticProduct[]>
>;

export interface CodingPlanStaticTeamProduct {
  productId: string;
  productName: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName: string;
  priceCurrency: "CNY";
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  renewAmount?: number;
  equity?: CodingPlanCardCopyConfigItem[];
  description?: CodingPlanCardCopyConfigItem[];
}

export type CodingPlanStaticTeamProductsConfig = Partial<
  Record<CodingPlanSubscriptionProviderId, CodingPlanStaticTeamProduct[]>
>;

export interface StartPlanPreviewEntitlement {
  grantUnits: number;
  meter: string;
  period: string;
  showName: string;
  unitType: string;
}

export interface StartPlanPreviewConfig {
  planId: string;
  name: string;
  entitlements: StartPlanPreviewEntitlement[];
}

export interface ForceUpdateConfig {
  minimalVersion: string;
}

export interface CodingPlanProductEquity {
  id?: number;
  productId?: string;
  productEquityTitle?: string;
  productEquityDetails?: string;
  createTime?: string;
  updateTime?: string;
}

export interface CodingPlanCampaignDiscountDetail {
  campaignName?: string;
  campaignDiscountAmount?: number;
  rewardMode?: string;
  rewardAmount?: number;
  rewardDetail?: string;
  applyScene?: string;
}

export type EnterpriseCodingPlanTier = "LITE" | "PRO" | "MAX";
export type EnterpriseCodingPlanSubscribeMode = "CONTINUOUS" | "ONE_TIME";
export type EnterpriseCodingPlanSubscribePeriod = "MONTHLY" | "QUARTERLY" | "YEARLY";
export interface EnterpriseCodingPlanPricingProduct {
  productId: string;
  tier: EnterpriseCodingPlanTier;
  subscribeMode: EnterpriseCodingPlanSubscribeMode;
  subscribePeriod: EnterpriseCodingPlanSubscribePeriod;
  purchaseMethodName?: string;
  originalAmount?: number;
  discountAmount?: number;
  payAmount?: number;
  renewAmount?: number;
  canRepurchase?: boolean | null;
  subscribed?: boolean | null;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanProjectContext[];
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus;
  apiKeyUnavailableReason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason | null;
  apiKeyUnavailableMessage?: string | null;
  campaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
}

export interface EnterpriseCodingPlanProjectContext {
  organizationId: string;
  organizationName?: string | null;
  projectId: string;
  projectName?: string | null;
  apiKeyStatus?: EnterpriseCodingPlanProjectApiKeyStatus;
  apiKeyUnavailableReason?: EnterpriseCodingPlanProjectApiKeyUnavailableReason | null;
  apiKeyUnavailableMessage?: string | null;
}

export type EnterpriseCodingPlanProjectApiKeyStatus = "available" | "unavailable" | "unknown";

export type EnterpriseCodingPlanProjectApiKeyUnavailableReason =
  | "no_valid_team_plan_authorization"
  | "request_failed";

export interface EnterpriseCodingPlanBalanceResponse {
  giveBalance: number;
  cashBalance: number;
  totalBalance: number;
}
