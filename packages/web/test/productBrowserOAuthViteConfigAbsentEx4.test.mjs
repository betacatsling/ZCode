/**
 * Soft pin: packages/web product browser OAuth Vite inject/proxy + orphan env types
 * absent (Ex4 Track B). Tip base a6e01a0 (#282) after P3 auth-stack drop (#33) left
 * zero-reader VITE_ZAI_OAUTH_* define + /api/v1/oauth/token login-debug proxy in
 * vite.config (#285) and zero-reader VITE_DEV_ORIGIN /
 * VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO in env.d.ts (only consumers were deleted
 * webZaiOAuthConfig / resolveWebAuthDevReturnTo).
 * DROP: resolveZaiOAuth* imports/locals, VITE_ZAI_OAUTH_CLIENT_ID|ORIGIN define,
 * /api/v1/oauth/token proxy, VITE_DEV_ORIGIN, VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO.
 * KEEP: productLoginRemoved, share login_required removed copy, VITE_ZCODE_BASE_URL /
 * ENDPOINT_ORIGIN, /ws+/api proxies, VITE_CONVERSATION_SHARE_PREVIEW_MOCK,
 * VITE_WEB_REMOTE_CONTROL_*, MCP OAuth (CLI), personal API-key, entitlement,
 * planCard/productPurchaseRemoved/Display/quota reset (ui), shared resolveZaiOAuth*
 * (desktop/main still uses), shouldOfferQuotaBannerUpgrade/requestLoginEntry pins,
 * client onPaymentCallback platform mirror.
 * Does not own tip-ledger / verify-product-login gate / packages/shared / desktop tsup.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITE_CONFIG = join(webRoot, "vite.config.ts");
const PRODUCT_LOGIN_REMOVED = join(webRoot, "src/auth/productLoginRemoved.ts");
const ENV_D_TS = join(webRoot, "src/env.d.ts");
const MAIN = join(webRoot, "src/main.tsx");

const DROP_VITE = [
  "resolveZaiOAuthClientId",
  "resolveZaiOAuthOrigin",
  "zaiOAuthClientId",
  "zaiOAuthOrigin",
  "VITE_ZAI_OAUTH_CLIENT_ID",
  "VITE_ZAI_OAUTH_ORIGIN",
  "/api/v1/oauth/token",
];

const DROP_ENV = ["VITE_DEV_ORIGIN", "VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO"];

test("DROP product ZAI OAuth Vite inject + oauth/token proxy absent from vite.config", () => {
  assert.equal(existsSync(VITE_CONFIG), true);
  const src = readFileSync(VITE_CONFIG, "utf8");
  for (const sym of DROP_VITE) {
    assert.equal(src.includes(sym), false, sym);
  }
});

test("DROP orphan product-OAuth env types absent from env.d.ts", () => {
  assert.equal(existsSync(ENV_D_TS), true);
  const envDts = readFileSync(ENV_D_TS, "utf8");
  for (const sym of DROP_ENV) {
    assert.equal(envDts.includes(sym), false, sym);
  }
});

test("KEEP endpoint inject + server proxies + productLoginRemoved", () => {
  const vite = readFileSync(VITE_CONFIG, "utf8");
  assert.match(vite, /resolveRuntimeZCodeEndpointOrigin/);
  assert.match(vite, /pickProductEndpointEnv/);
  assert.match(vite, /VITE_ZCODE_BASE_URL/);
  assert.match(vite, /VITE_ZCODE_ENDPOINT_ORIGIN/);
  assert.match(vite, /"\/ws"/);
  assert.match(vite, /"\/api"/);

  assert.equal(existsSync(PRODUCT_LOGIN_REMOVED), true);
  const removed = readFileSync(PRODUCT_LOGIN_REMOVED, "utf8");
  assert.match(removed, /PRODUCT_LOGIN_REMOVED_MESSAGE/);
  assert.match(removed, /PRODUCT_LOGIN_REMOVED_CODE/);

  const envDts = readFileSync(ENV_D_TS, "utf8");
  assert.equal(envDts.includes("VITE_ZAI_OAUTH"), false);
  assert.match(envDts, /VITE_ZCODE_BASE_URL/);
  assert.match(envDts, /VITE_CONVERSATION_SHARE_PREVIEW_MOCK/);
  assert.match(envDts, /VITE_WEB_REMOTE_CONTROL_ROUTE_PATH/);
  assert.match(envDts, /VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL/);

  const main = readFileSync(MAIN, "utf8");
  assert.match(main, /productLoginRemoved/);
  assert.match(main, /onPaymentCallback/);
});
