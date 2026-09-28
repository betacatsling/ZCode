/**
 * Soft pin: packages/shared product-login / purchase residuals absent (Ex3 Track B).
 * Tip base 6ae6e6f (#280) after services EMPTY (#276) / shared scout rebase.
 * DROP: login/oauth/logout TIDs; Coding Plan Static* / StartPlanPreview / system-busy /
 * balance/ProductEquity; isTrustedCodingPlanWebviewOrigin; buildZaiOAuthUrl builders.
 * KEEP: EnterpriseCodingPlanPricingProduct graph, ForceUpdateConfig, coding-plan-reset,
 * official-mcp-auth, usage-quota, OAuth provider ids / UserInfo / attribution,
 * resolveZaiOAuthOrigin|ClientId, manage URLs.
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sharedSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const SUBSCRIPTION = join(sharedSrc, "coding-plan-subscription.ts");
const TEST_IDS = join(sharedSrc, "test-ids.ts");
const ENDPOINT = join(sharedSrc, "zcodeEndpoint.ts");
const OAUTH = join(sharedSrc, "oauth.ts");
const RESET = join(sharedSrc, "coding-plan-reset.ts");
const MCP_AUTH = join(sharedSrc, "official-mcp-auth.ts");
const QUOTA = join(sharedSrc, "usage-quota.ts");

const DROP_SUBSCRIPTION = [
  "CodingPlanCatalogProviderId",
  "CODING_PLAN_SYSTEM_BUSY",
  "CodingPlanUnavailableReason",
  "CodingPlanStaticProduct",
  "CodingPlanStaticProductsConfig",
  "CodingPlanStaticTeamProduct",
  "CodingPlanStaticTeamProductsConfig",
  "CodingPlanStaticProductEquity",
  "CodingPlanCardCopyItem",
  "CodingPlanCardCopyConfigItem",
  "StartPlanPreviewEntitlement",
  "StartPlanPreviewConfig",
  "CodingPlanProductEquity",
  "EnterpriseCodingPlanBalanceResponse",
];

const DROP_TEST_IDS = [
  "TID_LOGIN_TRIGGER",
  "TID_LOGIN_MENU_ITEM",
  "TID_LOGIN_USE_API_KEY_BUTTON",
  "TID_LOGIN_API_KEY_PROVIDER_TRIGGER",
  "TID_LOGIN_API_KEY_PROVIDER_ITEM",
  "TID_LOGIN_API_KEY_INPUT",
  "TID_LOGIN_API_KEY_CONTINUE_BUTTON",
  "TID_LOGIN_API_KEY_CANCEL_BUTTON",
  "TID_LOGIN_API_KEY_SKIP_BUTTON",
  "TID_LOGIN_API_KEY_ERROR",
  "TID_OAUTH_LOGIN_BUTTON",
  "TID_OAUTH_CANCEL",
  "TID_OAUTH_ERROR",
  "TID_LOGOUT_BUTTON",
  "login-trigger",
  "oauth-login-button",
  "logout-button",
];

const DROP_ENDPOINT = [
  "isTrustedCodingPlanWebviewOrigin",
  "isLoopbackHostname",
  "buildZaiOAuthUrl",
  "buildRuntimeZaiOAuthUrl",
];

test("DROP shared coding-plan purchase-catalog / preview / busy / balance types", () => {
  assert.equal(existsSync(SUBSCRIPTION), true);
  const src = readFileSync(SUBSCRIPTION, "utf8");
  for (const sym of DROP_SUBSCRIPTION) {
    assert.equal(src.includes(sym), false, sym);
  }
});

test("KEEP ForceUpdateConfig + EnterpriseCodingPlanPricingProduct graph", () => {
  const src = readFileSync(SUBSCRIPTION, "utf8");
  assert.match(src, /export interface ForceUpdateConfig/);
  assert.match(src, /export interface EnterpriseCodingPlanPricingProduct/);
  assert.match(src, /export type EnterpriseCodingPlanTier/);
  assert.match(src, /export interface EnterpriseCodingPlanProjectContext/);
  assert.match(src, /export interface CodingPlanCampaignDiscountDetail/);
});

test("DROP product-login / oauth / logout TID_* exports", () => {
  assert.equal(existsSync(TEST_IDS), true);
  const src = readFileSync(TEST_IDS, "utf8");
  for (const sym of DROP_TEST_IDS) {
    assert.equal(src.includes(sym), false, sym);
  }
  assert.match(src, /export const TID_APP_HEADER/);
});

test("DROP Coding Plan webview trust + dead ZAI OAuth URL builders", () => {
  assert.equal(existsSync(ENDPOINT), true);
  const src = readFileSync(ENDPOINT, "utf8");
  for (const sym of DROP_ENDPOINT) {
    assert.equal(src.includes(sym), false, sym);
  }
  assert.match(src, /export function resolveZaiOAuthOrigin/);
  assert.match(src, /export function resolveZaiOAuthClientId/);
  assert.match(src, /export function buildBigModelCodingPlanPersonalManageUrl/);
  assert.match(src, /export function buildBigModelCodingPlanTeamManageUrl/);
});

test("KEEP oauth provider ids / attribution / UserInfo + reset + mcp-auth + quota", () => {
  const oauth = readFileSync(OAUTH, "utf8");
  assert.match(oauth, /export const BIGMODEL_PROVIDER_ID/);
  assert.match(oauth, /export const ZAI_PROVIDER_ID/);
  assert.match(oauth, /export interface OAuthLoginAttribution/);
  assert.match(oauth, /export interface UserInfo/);

  assert.equal(existsSync(RESET), true);
  assert.match(readFileSync(RESET, "utf8"), /export type CodingPlanResetType/);

  assert.equal(existsSync(MCP_AUTH), true);
  assert.match(readFileSync(MCP_AUTH, "utf8"), /ZCODE_OFFICIAL_MCP_AUTH_TYPE/);

  assert.equal(existsSync(QUOTA), true);
  assert.match(readFileSync(QUOTA, "utf8"), /export interface UsageQuotaSnapshot/);
});
