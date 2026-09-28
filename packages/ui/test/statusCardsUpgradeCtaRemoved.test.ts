import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const statusCards = readUi("../src/settings/model-provider-section/StatusCards.tsx");
const actions = readUi("../src/settings/model-provider-section/CodingPlanStatusActions.tsx");

test("StatusCards does not render Coding Plan upgrade CTA", () => {
  assert.equal(statusCards.includes("CodingPlanUpgradeAction"), false);
  assert.equal(statusCards.includes("canUpgrade"), false);
  assert.equal(statusCards.includes("openCodingPlanUpgrade"), false);
});

test("CodingPlanUpgradeAction export is removed", () => {
  assert.equal(actions.includes("CodingPlanUpgradeAction"), false);
  assert.match(actions, /CodingPlanProductPurchaseRemovedNotice/);
});
