import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldOfferQuotaBannerUpgrade } from "../src/v4/sessionQuotaBannerState.js";

describe("session quota banner upgrade removed", () => {
  it("never offers product Coding Plan upgrade CTA", () => {
    assert.equal(shouldOfferQuotaBannerUpgrade("model-exhausted"), false);
    assert.equal(shouldOfferQuotaBannerUpgrade("mcp-plan-required"), false);
    assert.equal(shouldOfferQuotaBannerUpgrade("mcp-quota-exhausted"), false);
    assert.equal(shouldOfferQuotaBannerUpgrade(null), false);
  });
});
