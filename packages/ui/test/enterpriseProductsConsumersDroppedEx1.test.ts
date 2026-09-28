import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("SettingsPage and V4ComposerToolbar drop empty useEnterpriseCodingPlanProducts callers", () => {
  for (const file of ["../src/SettingsPage.tsx", "../src/v4/composer/V4ComposerToolbar.tsx"]) {
    const source = readUi(file);
    assert.equal(source.includes("useEnterpriseCodingPlanProducts"), false, file);
    assert.match(source, /subscribedTeamProducts/, file);
  }
});

test("quota entitlement wiring remains on SettingsPage and V4ComposerToolbar", () => {
  const settings = readUi("../src/SettingsPage.tsx");
  assert.match(settings, /useUsageEntitlement/);
  assert.match(settings, /buildCodingPlanUsageSources/);
  assert.match(settings, /UsageStatsSection/);

  const toolbar = readUi("../src/v4/composer/V4ComposerToolbar.tsx");
  assert.match(toolbar, /useUsageEntitlement/);
  assert.match(toolbar, /resolveContextCodingPlanUsageSource/);
  assert.match(toolbar, /teamEntitlement/);
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
