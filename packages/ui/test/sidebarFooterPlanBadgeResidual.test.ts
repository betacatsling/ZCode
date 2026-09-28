import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("sidebar plan-badge helpers do not import UsageRemaining panel or product-login CTAs", () => {
  const helpers = readUi("../src/WorkspaceSidebarFooterPlanBadgeHelpers.ts");
  assert.equal(helpers.includes("CodingPlanUsageRemainingPanel"), false);
  assert.equal(helpers.includes("productLogin"), false);
  assert.equal(helpers.includes("openPurchase"), false);
  assert.equal(helpers.includes("requestLogin"), false);
  assert.match(helpers, /function hasActiveCodingPlanSnapshot/);
});

test("sidebar footer usage summary keeps read-only stats entry without upgrade/purchase CTAs", () => {
  const summary = readUi("../src/WorkspaceSidebarFooterUsageSummary.tsx");
  assert.equal(summary.includes("openCodingPlanUpgrade"), false);
  assert.equal(summary.includes("onUpgradeClick"), false);
  assert.equal(summary.includes("openPurchase"), false);
  assert.equal(summary.includes("requestLoginEntry"), false);
  assert.equal(summary.includes("升级入口"), false);
  assert.equal(summary.includes("购买面板"), false);
  assert.equal(summary.includes("产品 OAuth"), false);
  assert.match(summary, /setPendingSettingsUsageIntent/);
  assert.match(summary, /TID_SIDEBAR_CODING_PLAN_USAGE_BUTTON/);
  // Quota usage state may still resolve via shared helper export; panel module edit is Ex1.
  assert.match(summary, /resolveCodingPlanUsageRemainingState/);
});
