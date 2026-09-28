import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("SettingsPage/V4/sidebar drop dead usage-source builder callers", () => {
  for (const file of [
    "../src/SettingsPage.tsx",
    "../src/v4/composer/V4ComposerToolbar.tsx",
    "../src/WorkspaceSidebarFooterUsageSummary.tsx",
  ]) {
    const source = readUi(file);
    assert.equal(source.includes("useEnterpriseCodingPlanProducts"), false, file);
    assert.equal(source.includes("buildCodingPlanUsageSources"), false, file);
    assert.equal(source.includes("subscribedTeamProducts"), false, file);
  }
});

test("sidebar resolver drops the always-empty team source plumbing", () => {
  const resolver = readUi("../src/lib/codingPlanUsageSources.ts");
  const sidebar = readUi("../src/WorkspaceSidebarFooterUsageSummary.tsx");
  assert.equal(resolver.includes("teamSources"), false);
  assert.equal(sidebar.includes("teamSources"), false);
  assert.match(resolver, /buildPersonalCodingPlanUsageSource/);
  assert.match(resolver, /accountAccesses/);
});

test("quota entitlement wiring remains on SettingsPage and V4ComposerToolbar", () => {
  const settings = readUi("../src/SettingsPage.tsx");
  assert.match(settings, /useUsageEntitlement/);
  assert.match(settings, /buildPersonalCodingPlanUsageSource/);
  assert.match(settings, /UsageStatsSection/);

  const toolbar = readUi("../src/v4/composer/V4ComposerToolbar.tsx");
  assert.match(toolbar, /useUsageEntitlement/);
  assert.match(toolbar, /resolveContextCodingPlanUsageSource/);
  assert.match(toolbar, /teamEntitlement/);
});

test("orphan team/product-login helpers are removed", () => {
  for (const relativePath of [
    "../src/lib/teamPlanDisplayName.ts",
    "../src/settings/model-provider-section/codingPlanErrorMessage.ts",
  ]) {
    assert.equal(
      existsSync(fileURLToPath(new URL(relativePath, import.meta.url))),
      false,
      relativePath,
    );
  }
});

test("orphan useEnterpriseCodingPlanProducts hook is removed; Display/entitlement kept", () => {
  const hookPath = fileURLToPath(
    new URL("../src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts", import.meta.url),
  );
  assert.equal(existsSync(hookPath), false);

  const display = readUi("../src/settings/model-provider-section/enterpriseCodingPlanProducts.ts");
  assert.match(display, /export type EnterpriseCodingPlanProductDisplay/);
  assert.equal(display.includes("resolveEnterpriseCodingPlanProductList"), false);

  const entitlements = readUi("../src/settings/model-provider-section/useCodingPlanEntitlements.ts");
  assert.match(entitlements, /export function useCodingPlanEntitlements|useCodingPlanEntitlements/);
});

test("oauth team pricing empty productList and account-loss team fallback are removed", () => {
  const pricingPath = fileURLToPath(new URL("../src/root/oauthTeamPricing.ts", import.meta.url));
  assert.equal(existsSync(pricingPath), false);

  const suggestion = readUi("../src/root/accountConnectionLossSuggestion.ts");
  assert.equal(suggestion.includes("oauthTeamPricing"), false);
  assert.equal(suggestion.includes("getEnterprisePricingProducts"), false);
  assert.equal(suggestion.includes("productList"), false);
  assert.match(suggestion, /individual-coding-plan/);

  const notification = readUi("../src/root/useAccountConnectionLossNotification.ts");
  assert.match(notification, /prepareAccountConnectionSwitch/);
});
