/**
 * Soft pin: resolveBigModelStartPlanZcodeJwt / bigmodelStartPlanZcodeJwt absent (Ex4).
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const servicesSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const JWT_FILE = join(servicesSrc, "model-provider/bigmodelStartPlanZcodeJwt.ts");

test("DROP bigmodelStartPlanZcodeJwt.ts absent", () => {
  assert.equal(existsSync(JWT_FILE), false);
});

test("DROP resolveBigModelStartPlanZcodeJwt absent from model-provider sources", () => {
  const dir = join(servicesSrc, "model-provider");
  for (const name of [
    "zaiStartPlanBilling.ts",
    "providerProvisioningSource.ts",
    "providerProvisioningTarget.ts",
    "providerRuntime.ts",
    "providerFacadeServices.ts",
  ]) {
    const src = readFileSync(join(dir, name), "utf8");
    assert.equal(src.includes("resolveBigModelStartPlanZcodeJwt"), false, name);
    assert.equal(src.includes("bigmodelStartPlanZcodeJwt"), false, name);
  }
});

test("KEEP personal credential assembly + Start Plan balance still present", () => {
  const node = readFileSync(join(servicesSrc, "node.ts"), "utf8");
  assert.match(node, /createCredentialService\s*\(/);
  const billing = readFileSync(join(servicesSrc, "model-provider/zaiStartPlanBilling.ts"), "utf8");
  assert.match(billing, /export async function fetchZaiStartPlanBalanceEnvelope/);
  assert.match(billing, /export function buildZaiStartPlanBalanceUrl/);
});
