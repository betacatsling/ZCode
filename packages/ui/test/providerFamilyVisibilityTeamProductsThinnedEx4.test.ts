import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("providerFamilyConnectionVisibility drops empty subscribedTeamProducts team nav flatMap", () => {
  const source = readUi(
    "../src/settings/model-provider-section/providerFamilyConnectionVisibility.ts",
  );
  assert.equal(source.includes("subscribedTeamProducts.flatMap"), false);
  assert.equal(source.includes("resolveEnterpriseCodingPlanProductFamily"), false);
  assert.equal(source.includes("isTeamPlanQuotaUnavailable"), false);
  assert.match(source, /buildEntitlementTeamPlanItems/);
  assert.match(source, /buildSelectedTeamPlanFallbackItems/);
  assert.match(source, /subscribedTeamProducts/);
  assert.match(source, /EnterpriseCodingPlanProductDisplay/);
});
