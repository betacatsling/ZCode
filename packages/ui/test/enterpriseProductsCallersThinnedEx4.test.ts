import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("ModelProviderSection and sidebar drop empty useEnterpriseCodingPlanProducts callers", () => {
  for (const file of [
    "../src/settings/ModelProviderSection.tsx",
    "../src/WorkspaceSidebarFooterUsageSummary.tsx",
  ]) {
    const source = readUi(file);
    assert.equal(source.includes("useEnterpriseCodingPlanProducts"), false, file);
    assert.match(source, /subscribedTeamProducts/, file);
  }
});

test("enterprise Display type and manage/planCard copy remain", () => {
  const display = readUi("../src/settings/model-provider-section/enterpriseCodingPlanProducts.ts");
  assert.match(display, /export type EnterpriseCodingPlanProductDisplay/);
  assert.equal(display.includes("resolveEnterpriseCodingPlanProductList"), false);

  const en = readUi("../src/i18n/locales/en-US.ts");
  assert.match(en, /"settings\.modelProvider\.codingPlan\.manage"/);
  assert.match(en, /"settings\.modelProvider\.planCard\.codingPlan"/);
});
