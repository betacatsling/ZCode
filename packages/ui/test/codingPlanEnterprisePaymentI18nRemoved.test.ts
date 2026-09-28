import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const enUS = readUi("../src/i18n/locales/en-US.ts");
const zhCN = readUi("../src/i18n/locales/zh-CN.ts");

/** Acquisition checkout / pricing-dialog locale prefixes — must stay absent. */
const DEAD_PREFIXES = [
  "settings.modelProvider.codingPlan.enterprise.",
  "settings.modelProvider.codingPlan.overseasPayment.",
  "settings.modelProvider.codingPlan.paymentDialog.",
  "settings.modelProvider.codingPlan.start.",
  "settings.modelProvider.codingPlan.product.",
  "settings.modelProvider.codingPlan.securityVerification",
] as const;

const KEEP_KEYS = [
  "settings.modelProvider.codingPlan.manage",
  "settings.modelProvider.codingPlan.productPurchaseRemoved",
  "settings.modelProvider.planCard.codingPlan",
  "settings.modelProvider.planCard.startPlan",
] as const;

test("UI locales drop Coding Plan enterprise/overseasPayment acquisition i18n", () => {
  for (const locale of [enUS, zhCN]) {
    for (const prefix of DEAD_PREFIXES) {
      assert.equal(locale.includes(`"${prefix}`), false, prefix);
    }
  }
});

test("UI locales keep purchased manage / planCard / purchase-removed copy", () => {
  for (const locale of [enUS, zhCN]) {
    for (const key of KEEP_KEYS) {
      assert.equal(locale.includes(`"${key}"`), true, key);
    }
  }
});
