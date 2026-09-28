import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const settingsRoot = new URL("../src/settings/", import.meta.url);

test("coding plan login recovery and upgrade dialog modules are removed", () => {
  const recoveryPath = fileURLToPath(
    new URL("../src/settings/codingPlanUpgradeLoginRecovery.ts", import.meta.url),
  );
  const dialogPath = fileURLToPath(
    new URL("../src/settings/CodingPlanUpgradeDialog.tsx", import.meta.url),
  );
  const providerPath = fileURLToPath(
    new URL("../src/settings/CodingPlanUpgradeDialogProvider.tsx", import.meta.url),
  );
  assert.equal(existsSync(recoveryPath), false);
  assert.equal(existsSync(dialogPath), false);
  assert.equal(existsSync(providerPath), false);

  const presentation = readFileSync(
    new URL("model-provider-section/codingPlanProductPresentation.ts", settingsRoot),
    "utf8",
  );
  assert.match(presentation, /CODING_PLAN_PRODUCT_PURCHASE_CARDS_REMOVED\s*=\s*true/);

  const pricingCards = readFileSync(
    new URL("model-provider-section/codingPlanPricingCards.ts", settingsRoot),
    "utf8",
  );
  assert.match(pricingCards, /export type CodingPlanLoginOptions/);
  assert.equal(pricingCards.includes("shouldOfferCodingPlanOAuthPurchase"), false);
  assert.equal(pricingCards.includes("resolveCodingPlanUpgradeProductsProviderId"), false);
});

test("CodingPlanEmbeddedWebviewDialog and helpers are removed", () => {
  const embeddedDialogPath = fileURLToPath(
    new URL("../src/settings/CodingPlanEmbeddedWebviewDialog.tsx", import.meta.url),
  );
  const embeddedHelpersPath = fileURLToPath(
    new URL(
      "../src/settings/model-provider-section/codingPlanEmbeddedWebview.ts",
      import.meta.url,
    ),
  );
  assert.equal(existsSync(embeddedDialogPath), false);
  assert.equal(existsSync(embeddedHelpersPath), false);
});

test("codingPlanPurchaseAuth module is removed", () => {
  const purchaseAuthPath = fileURLToPath(
    new URL("model-provider-section/codingPlanPurchaseAuth.ts", settingsRoot),
  );
  assert.equal(existsSync(purchaseAuthPath), false);
});

test("Detail no longer renders Coding Plan purchase choice banners", () => {
  const detail = readFileSync(
    new URL("model-provider-section/Detail.tsx", settingsRoot),
    "utf8",
  );
  assert.equal(detail.includes("CodingPlanPurchaseChoiceBanners"), false);
  assert.equal(detail.includes("purchaseChoiceBannersVisible"), false);
  assert.equal(detail.includes("PurchaseChoiceBannerPrice"), false);
});

test("settings coding plan surface does not call product login entry", () => {
  const files = [
    "ModelProviderSection.tsx",
    "AutomationsSection.tsx",
    "model-provider-section/CodingPlanStatusActions.tsx",
    "model-provider-section/CodingPlanStatusMeta.tsx",
    "model-provider-section/StatusCards.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, settingsRoot), "utf8");
    assert.equal(source.includes("requestLoginEntry("), false, file);
  }
});
