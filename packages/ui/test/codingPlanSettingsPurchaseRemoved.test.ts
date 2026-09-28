import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createCodingPlanAuthInjectionScript,
  getCodingPlanCredentialKeys,
} from "../src/settings/model-provider-section/codingPlanEmbeddedWebview.js";
import { isCodingPlanPurchaseAuthPending } from "../src/settings/model-provider-section/codingPlanPurchaseAuth.js";
import { shouldOfferCodingPlanOAuthPurchase } from "../src/settings/model-provider-section/codingPlanPricingCards.js";

const settingsRoot = new URL("../src/settings/", import.meta.url);

test("coding plan login recovery module is removed", () => {
  const recoveryPath = fileURLToPath(new URL("../src/settings/codingPlanUpgradeLoginRecovery.ts", import.meta.url));
  assert.equal(existsSync(recoveryPath), false);
  const dialogSource = readFileSync(new URL("CodingPlanUpgradeDialog.tsx", settingsRoot), "utf8");
  assert.equal(dialogSource.includes("beginCodingPlanUpgradeLogin"), false);
  assert.equal(dialogSource.includes("resolvePendingCodingPlanUpgradeAfterLogin"), false);
  assert.equal(shouldOfferCodingPlanOAuthPurchase({ forceOAuth: true }), false);
  assert.equal(isCodingPlanPurchaseAuthPending("loading"), false);
  assert.equal(isCodingPlanPurchaseAuthPending("authenticated"), false);
});

test("embedded coding plan script clears product credentials instead of injecting them", () => {
  const script = createCodingPlanAuthInjectionScript({
    provider: "zai",
    credentials: {
      zaiAccessToken: "secret-access",
      zcodeJwtToken: "secret-jwt",
      bigmodelAccessToken: "secret-bigmodel",
    },
    theme: "zai-dark",
    locale: "zh-CN",
  });
  assert.equal(script.includes("secret-access"), false);
  assert.equal(script.includes("secret-jwt"), false);
  assert.equal(script.includes("secret-bigmodel"), false);
  assert.match(script, /localStorage\.removeItem\("oauth:zai:access_token"\)/);
  assert.match(script, /localStorage\.removeItem\("zcodejwttoken"\)/);
  assert.match(script, /localStorage\.removeItem\("oauth:bigmodel:access_token"\)/);
  assert.doesNotMatch(script, /localStorage\.setItem\("oauth:/);
  assert.doesNotMatch(script, /localStorage\.setItem\("zcodejwttoken"/);
  assert.deepEqual(getCodingPlanCredentialKeys("zai"), []);
  assert.deepEqual(getCodingPlanCredentialKeys("bigmodel"), []);
});

test("settings coding plan surface does not call product login entry", () => {
  const files = [
    "CodingPlanUpgradeDialog.tsx",
    "CodingPlanUpgradeDialogProvider.tsx",
    "CodingPlanEmbeddedWebviewDialog.tsx",
    "ModelProviderSection.tsx",
    "AutomationsSection.tsx",
    "model-provider-section/codingPlanEmbeddedWebview.ts",
    "model-provider-section/codingPlanPurchaseAuth.ts",
    "model-provider-section/CodingPlanStatusActions.tsx",
    "model-provider-section/CodingPlanStatusMeta.tsx",
    "model-provider-section/StatusCards.tsx",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(file, settingsRoot), "utf8");
    assert.equal(source.includes("requestLoginEntry("), false, file);
  }
});
