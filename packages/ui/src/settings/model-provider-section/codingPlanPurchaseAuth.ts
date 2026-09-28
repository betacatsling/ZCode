import { isCodingPlanModelProviderId } from "@zcode/shared";
import { type CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

type CodingPlanPurchaseAuthStatus =
  | "unknown"
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "error";

export function isCodingPlanPurchaseAuthPending(_status: CodingPlanPurchaseAuthStatus): boolean {
  // 购买鉴权的 unknown/loading 不再表示“等产品登录后继续购买”。
  return false;
}

export function normalizeCodingPlanProviderId(
  providerId: string | null | undefined,
): CodingPlanProviderId | null {
  const normalized = providerId?.trim();
  return normalized && isCodingPlanModelProviderId(normalized)
    ? (normalized as CodingPlanProviderId)
    : null;
}

export function isCodingPlanProviderId(
  providerId: CodingPlanProviderId | null,
): providerId is CodingPlanProviderId {
  return Boolean(providerId);
}
