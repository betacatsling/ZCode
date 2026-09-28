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

  assert.equal(
    existsSync(
      fileURLToPath(new URL("model-provider-section/codingPlanProductPresentation.ts", settingsRoot)),
    ),
    false,
  );

  assert.equal(
    existsSync(fileURLToPath(new URL("model-provider-section/codingPlanPricingCards.ts", settingsRoot))),
    false,
  );
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
  assert.equal(detail.includes("CodingPlanAccessBanner"), false);
  assert.equal(detail.includes("CodingPlanLoginOptions"), false);
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

test("StartPlan acquisition preview and personal product list hooks are removed", () => {
  assert.equal(
    existsSync(fileURLToPath(new URL("model-provider-section/StartPlanCard.tsx", settingsRoot))),
    false,
  );
  assert.equal(
    existsSync(fileURLToPath(new URL("model-provider-section/useStartPlanPreview.ts", settingsRoot))),
    false,
  );
  assert.equal(
    existsSync(fileURLToPath(new URL("model-provider-section/useCodingPlanProducts.ts", settingsRoot))),
    false,
  );
  assert.equal(
    existsSync(
      fileURLToPath(new URL("model-provider-section/codingPlanEnterpriseTiers.ts", settingsRoot)),
    ),
    false,
  );

  const statusCards = readFileSync(
    new URL("model-provider-section/StatusCards.tsx", settingsRoot),
    "utf8",
  );
  assert.equal(statusCards.includes("StartPlanCard"), false);
  assert.equal(statusCards.includes("useStartPlanPreview"), false);
  assert.equal(statusCards.includes("startPlanPreviewVisible"), false);

  const detail = readFileSync(
    new URL("model-provider-section/Detail.tsx", settingsRoot),
    "utf8",
  );
  assert.equal(detail.includes("startPlanPreviewVisible"), false);

  assert.equal(
    existsSync(
      fileURLToPath(new URL("model-provider-section/codingPlanProductPresentation.ts", settingsRoot)),
    ),
    false,
  );

  const enterprise = readFileSync(
    new URL("model-provider-section/enterpriseCodingPlanProducts.ts", settingsRoot),
    "utf8",
  );
  assert.equal(enterprise.includes("normalizeCodingPlanCardCopyItems"), false);
  assert.equal(enterprise.includes("equity:"), false);
  assert.equal(enterprise.includes("descriptionItems"), false);
  assert.equal(enterprise.includes("CodingPlanStaticTeamProduct"), false);

  const enterpriseHook = readFileSync(
    new URL("model-provider-section/useEnterpriseCodingPlanProducts.ts", settingsRoot),
    "utf8",
  );
  assert.equal(enterpriseHook.includes("staticOnly"), false);
  assert.equal(enterpriseHook.includes("getStaticTeamProducts"), false);
  assert.equal(enterpriseHook.includes("staticProductIds"), false);
});

test("StatusCards and Detail drop dead upgradePlansVisible acquisition gate", () => {
  const statusCards = readFileSync(
    new URL("model-provider-section/StatusCards.tsx", settingsRoot),
    "utf8",
  );
  assert.equal(statusCards.includes("upgradePlansVisible"), false);

  const detail = readFileSync(
    new URL("model-provider-section/Detail.tsx", settingsRoot),
    "utf8",
  );
  assert.equal(detail.includes("upgradePlansVisible"), false);
  assert.equal(detail.includes("setUpgradePlansVisibleProviderId"), false);
});

test("settings StatusCards path drops dead Coding Plan upgrade/purchase CTA strings", () => {
  const deadKeys = [
    "settings.modelProvider.codingPlan.subscribe",
    "settings.modelProvider.codingPlan.upgrade",
    "settings.modelProvider.codingPlan.renew",
    "settings.modelProvider.codingPlan.currentPlan",
    "settings.modelProvider.codingPlan.cancelUpgrade",
    "settings.modelProvider.codingPlan.purchase.individualsSectionTitle",
    "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle",
    "settings.modelProvider.codingPlan.purchase.selectPlan",
  ];
  for (const locale of ["en-US.ts", "zh-CN.ts"] as const) {
    const source = readFileSync(new URL(`../src/i18n/locales/${locale}`, import.meta.url), "utf8");
    for (const key of deadKeys) {
      assert.equal(source.includes(`"${key}"`), false, `${locale}:${key}`);
    }
    assert.equal(source.includes('"settings.modelProvider.connection.selectPlan"'), true, locale);
  }

  const header = readFileSync(
    new URL("model-provider-section/ProviderFamilyModeHeader.tsx", settingsRoot),
    "utf8",
  );
  assert.equal(header.includes("codingPlan.purchase.selectPlan"), false);
  assert.equal(header.includes("settings.modelProvider.connection.selectPlan"), true);

  const notification = readFileSync(
    new URL("../src/root/useAccountConnectionLossNotification.ts", import.meta.url),
    "utf8",
  );
  assert.equal(notification.includes("purchaseBanner.startPlanTitle"), false);
  assert.equal(notification.includes("purchase.individualsSectionTitle"), false);
  assert.equal(notification.includes("settings.modelProvider.planCard.startPlan"), true);
  assert.equal(notification.includes("settings.modelProvider.planCard.codingPlan"), true);

  const statusCards = readFileSync(
    new URL("model-provider-section/StatusCards.tsx", settingsRoot),
    "utf8",
  );
  assert.equal(statusCards.includes("右侧升级 Coding Plan 入口"), false);
  assert.equal(statusCards.includes("StartPlanQuotaStatusCard"), true);
});
