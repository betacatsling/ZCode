/**
 * Coding Plan subscription / entitlement protocol types still imported by UI.
 * Dead purchase-catalog Static* / StartPlanPreview / system-busy / balance /
 * standalone ProductEquity exports removed (Track B soft residual Ex3 @ tip).
 * KEEP ForceUpdateConfig (desktop forceUpdateGuard) and EnterpriseCodingPlan*
 * PricingProduct graph (enterpriseCodingPlanProducts Display).
 */

export interface ForceUpdateConfig {
  minimalVersion: string;
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
