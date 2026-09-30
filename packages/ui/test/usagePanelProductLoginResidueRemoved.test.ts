import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const oauthProviderIcon = readUi("../src/lib/oauthProviderIcon.tsx");
const usageRemaining = readUi("../src/CodingPlanUsageRemainingPanel.tsx");
const sidebarUsage = readUi("../src/WorkspaceSidebarFooterUsageSummary.tsx");
const zhCN = readUi("../src/i18n/locales/zh-CN.ts");
const enUS = readUi("../src/i18n/locales/en-US.ts");

test("oauthProviderIcon fallback is not a LogIn glyph", () => {
  assert.equal(oauthProviderIcon.includes("LogInIcon"), false);
  assert.match(oauthProviderIcon, /CircleIcon/);
});

test("sidebar usage upgrade/renew i18n keys are removed", () => {
  assert.equal(zhCN.includes('"sidebar.usage.plan.upgrade"'), false);
  assert.equal(zhCN.includes('"sidebar.usage.plan.renew"'), false);
  assert.equal(enUS.includes('"sidebar.usage.plan.upgrade"'), false);
  assert.equal(enUS.includes('"sidebar.usage.plan.renew"'), false);
});

test("usage remaining panel keeps productLoginRemoved and does not revive loginRequired", () => {
  assert.equal(usageRemaining.includes("sidebar.usage.plan.loginRequired"), false);
  assert.match(usageRemaining, /chat\.quota\.plan\.productLoginRemoved/);
});

test("sidebar usage summary content has no upgrade CTA wiring", () => {
  assert.equal(sidebarUsage.includes("onUpgradeClick"), false);
  assert.equal(sidebarUsage.includes("sidebar.usage.plan.upgrade"), false);
  assert.equal(sidebarUsage.includes("sidebar.usage.plan.renew"), false);
  assert.equal(sidebarUsage.includes("useCodingPlanEntryGate"), false);
  assert.match(sidebarUsage, /sidebar\.usage\.plan\.openStats/);
});
