import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const enUS = readUi("../src/i18n/locales/en-US.ts");
const zhCN = readUi("../src/i18n/locales/zh-CN.ts");

/**
 * Zero-ref Track B residue after #162/#168/#172: usage billingBanner buy/connect
 * acquisition, orphan chat.error relogin CTAs, dead renew CTA, unused OffPeak
 * codingPlanToast twin, and unused codingPlanNotConfigured empty-state.
 * KEEP entitlement / CurrentConnection / codingPlanOnly / upgrade label / manage·planCard.
 */
const DEAD_KEYS = [
  "settings.usage.billingBanner.title",
  "settings.usage.billingBanner.description",
  "settings.usage.billingBanner.compactDescription",
  "settings.usage.billingBanner.buy",
  "settings.usage.billingBanner.apiKeys",
  "settings.usage.billingBanner.usageDetails",
  "settings.usage.codingPlanNotConfiguredTitle",
  "settings.usage.codingPlanNotConfiguredDescription",
  "chat.error.reloginProvider",
  "chat.error.action.relogin",
  "chat.quota.action.renew",
  "offPeak.create.codingPlanToast",
] as const;

const KEEP_KEYS = [
  "settings.usage.entitlementTitle",
  "settings.usage.codingPlanCurrentConnectionTitle",
  "settings.usage.codingPlanCurrentConnectionDescription",
  "offPeak.create.codingPlanOnly",
  "chat.quota.action.upgrade",
  "chat.quota.plan.productLoginRemoved",
  "chat.error.action.refreshQuota",
  "settings.modelProvider.codingPlan.manage",
  "settings.modelProvider.codingPlan.productPurchaseRemoved",
  "settings.modelProvider.planCard.codingPlan",
  "settings.modelProvider.planCard.startPlan",
] as const;

const DEAD_PREFIXES = ["settings.usage.billingBanner."] as const;

test("UI locales drop zero-ref billingBanner / relogin / renew / codingPlanToast residue", () => {
  for (const locale of [enUS, zhCN]) {
    for (const key of DEAD_KEYS) {
      assert.equal(locale.includes(`"${key}"`), false, key);
    }
    for (const prefix of DEAD_PREFIXES) {
      assert.equal(locale.includes(`"${prefix}`), false, prefix);
    }
    for (const key of KEEP_KEYS) {
      assert.equal(locale.includes(`"${key}"`), true, `keep ${key}`);
    }
  }
});
