import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("Ex1 leaves hook definition and Ex4 caller files untouched", () => {
  // Presence-only sanity: hook stub still exists for remaining signature consumers.
  const hook = readUi("../src/settings/model-provider-section/useEnterpriseCodingPlanProducts.ts");
  assert.match(hook, /export function useEnterpriseCodingPlanProducts/);
});
