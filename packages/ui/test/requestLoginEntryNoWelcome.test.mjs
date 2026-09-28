import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");

test("Root no longer mounts WelcomeScreen or product OAuth login effects", () => {
  const root = readFileSync(join(uiSrc, "Root.tsx"), "utf8");
  assert.equal(root.includes("WelcomeScreen"), false);
  assert.equal(root.includes("useRootOAuthEffects"), false);
  assert.equal(root.includes("useOAuth"), false);
  assert.equal(root.includes("setWelcomeScreenOpenReason"), false);
  assert.equal(root.includes("loginEntryRequest"), false);
});

test("requestLoginEntry stays callable but never publishes loginEntryRequest", () => {
  const store = readFileSync(join(uiSrc, "store/index.ts"), "utf8");
  assert.match(store, /requestLoginEntry:\s*\([^)]*\)\s*=>\s*\{/);
  assert.match(store, /Product Welcome \/ Root OAuth login shell removed/);
  // The no-op must not write loginEntryRequest inside requestLoginEntry.
  const fnStart = store.indexOf("requestLoginEntry: (_providerId");
  assert.ok(fnStart > 0, "expected no-op requestLoginEntry signature");
  const fnBody = store.slice(fnStart, store.indexOf("clearLoginEntryRequest:", fnStart));
  assert.equal(fnBody.includes("loginEntryRequest:"), false);
  assert.equal(fnBody.includes("loginEntryAttempt:"), false);
});

test("product OAuth shell modules are removed", () => {
  const missing = [
    "WelcomeScreen.tsx",
    "hooks/useOAuth.ts",
    "root/useRootOAuthEffects.ts",
    "root/oauthCachedSessionRestore.ts",
    "root/oauthLoginAttemptGuard.ts",
    "root/oauthProviderFamilySelectionRefresh.ts",
    "root/zcodeJwtInvalidRestartMarker.ts",
    "root/useProviderAvailabilityLoginEntryGuard.ts",
  ];
  for (const rel of missing) {
    let exists = true;
    try {
      readFileSync(join(uiSrc, rel));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, `${rel} should be deleted`);
  }
});

test("loginEntryGuard enable toggle stays absent from rootStartupGate", () => {
  const gate = readFileSync(join(uiSrc, "lib/rootStartupGate.ts"), "utf8");
  assert.equal(gate.includes("shouldEnableProviderAvailabilityLoginEntryGuard"), false);
  assert.equal(gate.includes("shouldRedirectStartupToProductLogin"), false);
});
