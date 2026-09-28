/**
 * Soft pin: NodeApiClient product-JWT 401 observation hooks absent (Ex3 Track B).
 * Zero callers after product OAuth unload / #254 Start Plan JWT drop.
 * KEEP createNodeApiClient + resolveZCodeEndpointOrigin + fetchImpl.
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const servicesSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const CLIENT_FILE = join(servicesSrc, "providers/api/nodeApiClient.ts");

const DROP_SYMBOLS = ["onZcodeJwtInvalid", "isZcodeJwtRequest"] as const;

test("DROP NodeApiClient product-JWT 401 hooks absent", () => {
  assert.equal(existsSync(CLIENT_FILE), true);
  const src = readFileSync(CLIENT_FILE, "utf8");
  for (const sym of DROP_SYMBOLS) {
    assert.equal(src.includes(sym), false, sym);
  }
  assert.equal(src.includes("zcode jwt invalid response observation failed"), false);
});

test("KEEP createNodeApiClient + endpoint origin / fetch options", () => {
  const src = readFileSync(CLIENT_FILE, "utf8");
  assert.match(src, /export function createNodeApiClient/);
  assert.match(src, /export class NodeApiClient/);
  assert.match(src, /resolveZCodeEndpointOrigin/);
  assert.match(src, /fetchImpl/);
});

test("DROP product-JWT 401 hooks absent from node assembly callers", () => {
  const node = readFileSync(join(servicesSrc, "node.ts"), "utf8");
  for (const sym of DROP_SYMBOLS) {
    assert.equal(node.includes(sym), false, `node.ts :: ${sym}`);
  }
});
