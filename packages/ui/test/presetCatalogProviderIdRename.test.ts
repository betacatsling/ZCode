/**
 * Soft pin: presetSubscription* → presetCatalog* rename (#200).
 * Does not own statusPending Ex3 pins or verify tip ledger.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const modelProviderSection = readUi("../src/settings/ModelProviderSection.tsx");
const detail = readUi("../src/settings/model-provider-section/Detail.tsx");
const viewState = readUi(
  "../src/settings/model-provider-section/codingPlanStatusPanelViewState.ts",
);

test("ModelProviderSection and Detail use presetCatalogProviderId (not Subscription)", () => {
  for (const [label, src] of [
    ["ModelProviderSection", modelProviderSection],
    ["Detail", detail],
  ] as const) {
    assert.equal(
      src.includes("presetSubscriptionProviderId"),
      false,
      `${label} must not keep presetSubscriptionProviderId`,
    );
    assert.equal(
      src.includes("setPresetSubscriptionProviderId"),
      false,
      `${label} must not keep setPresetSubscriptionProviderId`,
    );
    assert.equal(
      src.includes("presetCatalogProviderId"),
      true,
      `${label} must use presetCatalogProviderId`,
    );
  }
  assert.equal(
    modelProviderSection.includes("setPresetCatalogProviderId"),
    true,
    "ModelProviderSection must use setPresetCatalogProviderId",
  );
});

test("KEEP statusPending / codingPlanStatusGatePending / productPurchaseRemoved / entitlement", () => {
  assert.equal(viewState.includes("statusPending"), true);
  assert.equal(detail.includes("codingPlanStatusGatePending"), true);
  assert.equal(detail.includes("statusPending"), true);
  assert.equal(detail.includes("productPurchaseRemoved"), true);
  assert.equal(detail.includes("entitlement"), true);
});
