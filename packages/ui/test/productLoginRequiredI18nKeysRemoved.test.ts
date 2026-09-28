import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const enUS = readUi("../src/i18n/locales/en-US.ts");
const zhCN = readUi("../src/i18n/locales/zh-CN.ts");
const shareImportIntent = readUi("../src/root/shareImportIntent.ts");

/** Dead product-login / Coding Plan /login locale keys — must stay absent. */
const DEAD_PRODUCT_LOGIN_KEYS = [
  "settings.modelProvider.codingPlan.login",
  "settings.modelProvider.codingPlan.productsLoginRequired",
  "settings.modelProvider.codingPlan.start.loginEnable",
  "settings.modelProvider.codingPlan.start.loginTrial",
  "settings.usage.entitlementLoginRequired",
  "settings.usage.entitlementStatusLoginRequired",
  "sidebar.usage.plan.loginRequired",
] as const;

test("UI locales drop dead product loginRequired / Coding Plan login keys", () => {
  for (const key of DEAD_PRODUCT_LOGIN_KEYS) {
    const needle = `"${key}"`;
    assert.equal(enUS.includes(needle), false, `en-US still has ${key}`);
    assert.equal(zhCN.includes(needle), false, `zh-CN still has ${key}`);
  }
});

test("ZCode account share-import signInRequired copy stays (not product login)", () => {
  assert.match(enUS, /"conversationShare\.import\.signInRequired"/);
  assert.match(zhCN, /"conversationShare\.import\.signInRequired"/);
  assert.match(shareImportIntent, /conversationShare\.import\.signInRequired/);
  assert.equal(shareImportIntent.includes("loginRequired"), false);
});
