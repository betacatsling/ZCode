/**
 * Soft pin: resolveZaiStartPlanBalanceModelIds absent (Ex4 Track B soft residual).
 * Zero callers after product OAuth unload; KEEP live Start Plan balance fetch/build.
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const servicesSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const BILLING_FILE = join(servicesSrc, "model-provider/zaiStartPlanBilling.ts");

test("DROP resolveZaiStartPlanBalanceModelIds absent from Start Plan balance file", () => {
  assert.equal(existsSync(BILLING_FILE), true);
  const billing = readFileSync(BILLING_FILE, "utf8");
  assert.equal(billing.includes("resolveZaiStartPlanBalanceModelIds"), false);
});

test("KEEP Start Plan balance fetch/build still present", () => {
  const billing = readFileSync(BILLING_FILE, "utf8");
  assert.match(billing, /export async function fetchZaiStartPlanBalanceEnvelope/);
  assert.match(billing, /export function buildZaiStartPlanBalanceUrl/);
  assert.match(billing, /export interface ZaiStartPlanBalanceEnvelope/);
});
