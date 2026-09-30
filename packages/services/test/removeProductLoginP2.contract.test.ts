/**
 * P2 contract — product login service assembly is gone.
 *
 * Plan: docs/harness-refactor/REMOVE-PRODUCT-LOGIN-PLAN.md §P2
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const servicesSrc = join(here, "../src");

function readSrc(rel: string): string {
  return readFileSync(join(servicesSrc, rel), "utf8");
}

test("P2: oauth service is no longer exported", () => {
  const index = readSrc("index.ts");
  const node = readSrc("node.ts");
  assert.equal(existsSync(join(servicesSrc, "oauth/oauth.ts")), false);
  assert.equal(existsSync(join(servicesSrc, "oauth/oauthService.ts")), false);
  assert.doesNotMatch(index, /IOAuthService/);
  assert.doesNotMatch(node, /export \{ createOAuthService/);
  assert.doesNotMatch(node, /export \{ OAuthCredentialRepo/);
});

test("P2: node.ts does not create or register product OAuth", () => {
  const node = readSrc("node.ts");
  assert.doesNotMatch(node, /createOAuthService\s*\(/);
  assert.doesNotMatch(node, /new OAuthCredentialRepo\s*\(/);
  assert.doesNotMatch(node, /\.register\(\s*IOAuthService\s*,/);
  assert.doesNotMatch(node, /isCurrentOAuthCredentialRequest\s*\(/);
});

test("P2: node.ts does not wire the accountProvider auth chain", () => {
  const node = readSrc("node.ts");
  for (const needle of [
    "createAccountProviderCredentialStore(",
    "createAccountProviderCredentialService(",
    "createAccountRequestAuthService(",
    "createAccountProviderRequestAuthService(",
    "createAccountProviderConfigSource(",
    "createCodingPlanFamilyAvailabilityResolver(",
    "bindAccountProviderInvalidation(",
    "new AccountProviderApiClient",
    "new AccountProviderApiKeyResolver",
  ]) {
    assert.equal(node.includes(needle), false, `assembly still present: ${needle}`);
  }
  assert.equal(existsSync(join(servicesSrc, "model-provider/accountRequestAuthService.ts")), false);
});

test("P2: Coding Plan subscription is not created or registered", () => {
  const node = readSrc("node.ts");
  const index = readSrc("index.ts");
  assert.doesNotMatch(node, /createCodingPlanSubscriptionService\s*\(/);
  assert.doesNotMatch(node, /ICodingPlanSubscriptionService/);
  assert.doesNotMatch(index, /ICodingPlanSubscriptionService/);
  assert.equal(
    existsSync(join(servicesSrc, "coding-plan-subscription/codingPlanSubscriptionService.ts")),
    false,
  );
});

test("P2: personal credential and provider runtime stay in node assembly", () => {
  const node = readSrc("node.ts");
  assert.match(node, /createCredentialService\s*\(/);
  assert.match(node, /createProviderConfigRuntime\s*\(/);
  assert.match(node, /createProviderRuntimeFromConfigRuntime\s*\(/);
});
