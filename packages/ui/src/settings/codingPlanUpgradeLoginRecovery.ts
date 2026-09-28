import type { OAuthProviderId } from "@zcode/shared";
import type { PurchaseAudience } from "@/settings/model-provider-section/codingPlanEnterpriseTiers.js";

export interface CodingPlanUpgradeDialogTarget {
  providerId: string;
  initialAudience?: PurchaseAudience;
  initialTeamPlanKey?: string;
  funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext;
}

interface PendingCodingPlanUpgradeAfterLogin {
  loginAttemptId: number;
  target: CodingPlanUpgradeDialogTarget;
}

/**
 * 产品登录恢复已下线。
 * 购买中断不能再拉起产品 OAuth，也不会在登录成功后重开支付。
 */
export function beginCodingPlanUpgradeLogin(params: {
  target: CodingPlanUpgradeDialogTarget;
  oauthProviderId: OAuthProviderId;
  audience: PurchaseAudience;
  onClose: () => void;
}): PendingCodingPlanUpgradeAfterLogin {
  params.onClose();
  return {
    loginAttemptId: -1,
    target: {
      ...params.target,
      initialAudience: params.audience,
    },
  };
}

export function resolvePendingCodingPlanUpgradeAfterLogin(_params: {
  pending: PendingCodingPlanUpgradeAfterLogin | null;
  loginAttempt: {
    id: number;
    status: "requested" | "waiting" | "succeeded" | "cancelled" | "failed";
  } | null;
}):
  | { action: "wait" }
  | { action: "discard" }
  | { action: "reopen"; target: CodingPlanUpgradeDialogTarget } {
  // 登录成功也不重开购买。调用方若仍轮询恢复结果，只能丢掉挂起的购买目标。
  return { action: "discard" };
}
