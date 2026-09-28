import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const detail = readUi("../src/settings/model-provider-section/Detail.tsx");
const section = readUi("../src/settings/ModelProviderSection.tsx");
const actions = readUi("../src/settings/model-provider-section/modelProviderActions.ts");

test("settings model-provider Detail does not open Coding Plan upgrade", () => {
  assert.equal(detail.includes("useCodingPlanUpgradeDialog"), false);
  assert.equal(detail.includes("openCodingPlanUpgrade"), false);
  assert.equal(detail.includes("upgradeActionVisible"), false);
  assert.equal(detail.includes("onOpenUpgradePlans"), false);
  assert.equal(detail.includes("purchaseInitialAudience"), false);
});

test("settings ModelProviderSection drops Coding Plan product-login noop chain", () => {
  assert.equal(section.includes("useOptionalCodingPlanUpgradeDialog"), false);
  assert.equal(section.includes("useCodingPlanUpgradeDialog"), false);
  assert.equal(section.includes("openCodingPlanUpgrade"), false);
  assert.equal(section.includes("handleCodingPlanLogin"), false);
  assert.equal(section.includes("onCodingPlanLogin"), false);
  assert.equal(section.includes("产品登录已下线，不再连接 Coding Plan"), false);
  assert.equal(detail.includes("onCodingPlanLogin"), false);
});

test("settings model-provider Detail does not use CodingPlan entryGate", () => {
  assert.equal(detail.includes("useCodingPlanEntryGate"), false);
  assert.equal(detail.includes("CodingPlanEntryButton"), false);
  assert.equal(detail.includes("entryGate"), false);
  assert.equal(
    existsSync(fileURLToPath(new URL("../src/settings/CodingPlanEntryButton.tsx", import.meta.url))),
    false,
  );
});

test("settings model-provider Track B drops dead purchase-complete wiring", () => {
  for (const source of [section, detail, actions]) {
    assert.equal(source.includes("onCodingPlanPurchaseComplete"), false);
    assert.equal(source.includes("codingPlanPurchaseToken"), false);
    assert.equal(source.includes("refreshPurchaseTokenState"), false);
  }
  assert.match(detail, /onQuotaResetEntitlementRefresh/);
  assert.match(section, /refreshActiveOAuthProviderState/);
  assert.match(actions, /refreshActiveOAuthProvider/);
});
