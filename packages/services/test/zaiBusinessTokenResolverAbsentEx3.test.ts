/**
 * Soft pin: ZaiBusinessTokenResolver absent (Ex3 Track B soft residual).
 * Orphan after P2 product OAuth teardown — zero runtime importers; usage quota
 * hardcodes businessToken: null and no longer exchanges oauth access tokens.
 * KEEP balance fetch/build/envelope, BizContext, MCP OAuth, personal API-key,
 * entitlement, createTelemetry*Loader stubs, NodeApiClient (post-#272).
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const servicesSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const RESOLVER_FILE = join(servicesSrc, "providers/zaiBusinessTokenResolver.ts");

const DROP_SYMBOLS = [
  "ZaiBusinessTokenResolver",
  "zaiBusinessTokenResolver",
  "exchangeBusinessToken",
  "ZaiBusinessLoginEnvelope",
] as const;

test("DROP zaiBusinessTokenResolver.ts absent", () => {
  assert.equal(existsSync(RESOLVER_FILE), false);
});

test("DROP ZaiBusinessTokenResolver symbols absent from services sources", () => {
  const stack = [servicesSrc];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      const src = readFileSync(full, "utf8");
      for (const sym of DROP_SYMBOLS) {
        assert.equal(src.includes(sym), false, `${full} :: ${sym}`);
      }
    }
  }
});

test("KEEP Start Plan balance + team BizContext + telemetry stubs still present", () => {
  assert.equal(existsSync(join(servicesSrc, "model-provider/zaiStartPlanBilling.ts")), true);
  assert.equal(existsSync(join(servicesSrc, "bigmodel/teamPlanApiKey.ts")), true);
  const node = readFileSync(join(servicesSrc, "node.ts"), "utf8");
  assert.match(node, /export function createTelemetryUserIdLoader/);
  assert.match(node, /export function createTelemetryAuthorizationLoader/);
  assert.match(node, /createNodeApiClient/);
});
