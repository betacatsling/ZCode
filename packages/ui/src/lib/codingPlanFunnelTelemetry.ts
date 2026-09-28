/**
 * Coding Plan 购买/升级漏斗上下文类型。
 * 上报与 create/resolve 助手已随升级 CTA 下线删除；类型仍供 StatusCards /
 * CodingPlanUpgradeDialog / embedded webview 的 props 形状使用。
 */

export type CodingPlanUpgradeSource =
  | "profile_menu"
  | "session_quota_alert"
  | "session_token_usage"
  | "session_idle_time"
  | "setting_plan_card"
  | "setting_start_plan_card"
  | "setting_personal_plan_banner"
  | "setting_team_plan_banner";

export type CodingPlanEntryPlanStatus = "no_plan" | "start_plan" | "coding_plan" | "unknown";

export type CodingPlanPurchaseAudience = "" | "personal" | "team";
export type CodingPlanProviderFamily = "bigmodel" | "zai" | "unknown";

export interface CodingPlanFunnelContext {
  purchaseFunnelId: string;
  upgradeSource: CodingPlanUpgradeSource;
  eventRegion: string;
  eventText: string;
  entryPlanStatus: CodingPlanEntryPlanStatus;
  entryPlanLevel: string;
  entryPlanList: string;
  purchaseAudience: CodingPlanPurchaseAudience;
  providerFamily: CodingPlanProviderFamily;
  channel: string;
}
