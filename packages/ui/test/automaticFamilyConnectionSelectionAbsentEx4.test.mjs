/**
 * Soft pin: resolveAutomaticModelProviderFamilyConnectionSelection absent (Ex4).
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const ABSENT = "resolveAutomaticModelProviderFamilyConnectionSelection";

function* walkTsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* walkTsFiles(path);
      continue;
    }
    if (/\.(ts|tsx)$/.test(name)) yield path;
  }
}

test("resolveAutomaticModelProviderFamilyConnectionSelection is absent from packages/ui src", () => {
  for (const path of walkTsFiles(uiSrc)) {
    const src = readFileSync(path, "utf8");
    assert.equal(src.includes(ABSENT), false, path);
  }
});

test("KEEP resolveModelProviderFamilyConnectionProviderId + accountConnectionLossSuggestion caller", () => {
  const selection = readFileSync(
    join(uiSrc, "lib/modelProviderFamilyConnectionSelection.ts"),
    "utf8",
  );
  assert.match(selection, /export function resolveModelProviderFamilyConnectionProviderId/);
  assert.match(selection, /export type ModelProviderFamilyConnectionSelection/);
  assert.match(selection, /getModelProviderFamilySpec/);

  const suggestion = readFileSync(join(uiSrc, "root/accountConnectionLossSuggestion.ts"), "utf8");
  assert.match(suggestion, /resolveModelProviderFamilyConnectionProviderId/);
});
