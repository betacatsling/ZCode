import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("providerFamilyConnectionVisibility drops subscribedTeamProducts param and empty team-product nav", () => {
  const source = readUi(
    "../src/settings/model-provider-section/providerFamilyConnectionVisibility.ts",
  );
  assert.equal(source.includes("subscribedTeamProducts"), false);
  assert.equal(source.includes("EnterpriseCodingPlanProductDisplay"), false);
  assert.equal(source.includes("resolveEnterpriseCodingPlanProductFamily"), false);
  assert.equal(source.includes("isTeamPlanQuotaUnavailable"), false);
  assert.match(source, /buildEntitlementTeamPlanItems/);
  assert.match(source, /buildSelectedTeamPlanFallbackItems/);
  assert.equal(source.includes("appendSubscribedTeamPlanItems"), false);
  assert.match(source, /appendTeamPlanItems/);
});

test("useModelProviderNavigation drops subscribedTeamProducts param", () => {
  const nav = readUi("../src/settings/model-provider-section/useModelProviderNavigation.ts");
  assert.equal(nav.includes("subscribedTeamProducts"), false);
  assert.equal(nav.includes("EnterpriseCodingPlanProductDisplay"), false);
  assert.match(nav, /buildVisibleFamilyConnectionItems/);
});
