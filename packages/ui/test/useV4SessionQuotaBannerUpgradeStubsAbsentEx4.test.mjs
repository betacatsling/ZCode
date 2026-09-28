/**
 * Soft pin: upgradeProviderId / upgradeActionLabelId absent from
 * useV4SessionQuotaBanner return (Ex4). Does not own tip-ledger /
 * verify-product-login gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const HOOK = join(uiSrc, "v4/useV4SessionQuotaBanner.ts");
const STATE = join(uiSrc, "v4/sessionQuotaBannerState.ts");

test("DROP upgradeProviderId / upgradeActionLabelId absent from hook src", () => {
  const src = readFileSync(HOOK, "utf8");
  assert.equal(src.includes("upgradeProviderId"), false);
  assert.equal(src.includes("upgradeActionLabelId"), false);
});

test("KEEP shouldOfferQuotaBannerUpgrade still present in sessionQuotaBannerState", () => {
  const src = readFileSync(STATE, "utf8");
  assert.match(src, /export function shouldOfferQuotaBannerUpgrade/);
});
