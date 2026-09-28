/**
 * Soft pin: resolveQuotaBannerUpgradeProviderId absent (Ex4).
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const TARGET = join(uiSrc, "v4/sessionQuotaBannerState.ts");

test("DROP resolveQuotaBannerUpgradeProviderId absent from src file", () => {
  const src = readFileSync(TARGET, "utf8");
  assert.equal(src.includes("resolveQuotaBannerUpgradeProviderId"), false);
});

test("KEEP shouldOfferQuotaBannerUpgrade still present", () => {
  const src = readFileSync(TARGET, "utf8");
  assert.match(src, /export function shouldOfferQuotaBannerUpgrade/);
});
