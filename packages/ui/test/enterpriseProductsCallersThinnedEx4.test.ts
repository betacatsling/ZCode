import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("ModelProviderSection and sidebar drop empty useEnterpriseCodingPlanProducts callers", () => {
  const section = readUi("../src/settings/ModelProviderSection.tsx");
  assert.equal(section.includes("useEnterpriseCodingPlanProducts"), false);
  // MPS still passes subscribedTeamProducts: [] into navigation (Ex3/Ex4 OUT of this knife).
  assert.match(section, /subscribedTeamProducts/);

  const sidebar = readUi("../src/WorkspaceSidebarFooterUsageSummary.tsx");
  assert.equal(sidebar.includes("useEnterpriseCodingPlanProducts"), false);
  // Sidebar usage-sources call no longer stubs subscribedTeamProducts.
  assert.equal(sidebar.includes("subscribedTeamProducts"), false);
});

test("enterprise Display type and manage/planCard copy remain", () => {
  const display = readUi("../src/settings/model-provider-section/enterpriseCodingPlanProducts.ts");
  assert.match(display, /export type EnterpriseCodingPlanProductDisplay/);
  assert.equal(display.includes("resolveEnterpriseCodingPlanProductList"), false);

  const en = readUi("../src/i18n/locales/en-US.ts");
  assert.match(en, /"settings\.modelProvider\.codingPlan\.manage"/);
  assert.match(en, /"settings\.modelProvider\.planCard\.codingPlan"/);
});
