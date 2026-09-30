import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const enUS = readUi("../src/i18n/locales/en-US.ts");
const zhCN = readUi("../src/i18n/locales/zh-CN.ts");

/**
 * Zero-ref Start Plan acquisition/preview/highlight + plan-access connectionMode
 * residue (Ex1 residual3 handoff → Ex3 plan-mode/access/pricing knife).
 * KEEP live status / balance.title / refreshEntitlement / expiresAt / pendingUntil
 * and connectionMode labels still consumed by composer/settings.
 */
const DEAD_KEYS = [
  "settings.modelProvider.useSubscription",
  "settings.modelProvider.connectionMode.oauth",
  "settings.modelProvider.connectionMode.startPlanCount",
  "settings.modelProvider.connectionMode.switchToStartPlan",
  "settings.modelProvider.connectionMode.switchToStartPlanPrefix",
  "settings.modelProvider.connectionMode.usageBasedApi",
  "settings.modelProvider.connectionMode.noAvailablePlan",
  "settings.modelProvider.startPlan.login",
  "settings.modelProvider.startPlan.title",
  "settings.modelProvider.startPlan.meta.today",
  "settings.modelProvider.startPlan.meta.tomorrow",
  "settings.modelProvider.startPlan.quotaSectionTitle",
  "settings.modelProvider.startPlan.eligibleNewUser",
  "settings.modelProvider.startPlan.preview.unit.tokens",
  "settings.modelProvider.startPlan.preview.period.daily",
  "settings.modelProvider.startPlan.preview.entitlementSummary.daily",
  "settings.modelProvider.startPlan.preview.entitlementSummary.generic",
  "settings.modelProvider.startPlan.preview.entitlementGroup.single",
  "settings.modelProvider.startPlan.preview.entitlementGroup.each",
  "settings.modelProvider.startPlan.balance.remaining",
  "settings.modelProvider.startPlan.balance.used",
  "settings.modelProvider.startPlan.highlight.trial.label",
  "settings.modelProvider.startPlan.highlight.trial.value",
  "settings.modelProvider.startPlan.highlight.trial.description",
  "settings.modelProvider.startPlan.highlight.quota.label",
  "settings.modelProvider.startPlan.highlight.quota.value",
  "settings.modelProvider.startPlan.highlight.quota.description",
  "settings.modelProvider.startPlan.highlight.metering.label",
  "settings.modelProvider.startPlan.highlight.metering.value",
  "settings.modelProvider.startPlan.highlight.metering.description",
  "settings.modelProvider.startPlan.compatibility",
] as const;

const KEEP_KEYS = [
  "settings.modelProvider.connectionMode",
  "settings.modelProvider.connectionMode.startPlan",
  "settings.modelProvider.connectionMode.codingPlan",
  "settings.modelProvider.startPlan.status.expired",
  "settings.modelProvider.startPlan.status.noPlan",
  "settings.modelProvider.startPlan.status.loginExpired",
  "settings.modelProvider.startPlan.balance.title",
  "settings.modelProvider.startPlan.refreshEntitlement",
  "settings.modelProvider.startPlan.expiresAt",
  "settings.modelProvider.startPlan.pendingUntil",
  "settings.modelProvider.codingPlan.manage",
  "settings.modelProvider.codingPlan.productPurchaseRemoved",
  "settings.modelProvider.planCard.codingPlan",
  "settings.modelProvider.planCard.startPlan",
] as const;

const DEAD_PREFIXES = [
  "settings.modelProvider.startPlan.preview.",
  "settings.modelProvider.startPlan.highlight.",
] as const;

test("UI locales drop zero-ref plan-mode / access / pricing Start Plan i18n", () => {
  for (const locale of [enUS, zhCN]) {
    for (const key of DEAD_KEYS) {
      assert.equal(locale.includes(`"${key}"`), false, key);
    }
    for (const prefix of DEAD_PREFIXES) {
      assert.equal(locale.includes(`"${prefix}`), false, prefix);
    }
  }
});

test("UI locales keep live Start Plan status / balance / entitlement + manage/planCard", () => {
  for (const locale of [enUS, zhCN]) {
    for (const key of KEEP_KEYS) {
      assert.equal(locale.includes(`"${key}"`), true, key);
    }
  }
});
