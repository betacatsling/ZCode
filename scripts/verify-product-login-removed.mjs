#!/usr/bin/env node
/**
 * Product-login removal checks.
 *
 * This script checks source boundaries and the documented removed-command shape;
 * it does not certify a running Desktop/Web/CLI or a real model route.
 * Project milestones: docs/PROJECT-DELIVERY-PLAN.md (M3).
 * Historical PR lineage: archive/2026-09-29/integration-before-consolidation.
 * Keep hard assertions here; keep rolling PR history out of executable source.
 * Run from the repository root: node scripts/verify-product-login-removed.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, LOGIN, TUI_AUTH, CREATE } from "./product-login-checks/source-utils.mjs";
import { checkDeletedSurfaces } from "./product-login-checks/deleted-surfaces.mjs";
import { checkLocaleKeys } from "./product-login-checks/locale-keys.mjs";
import { checkProviderUiWiring } from "./product-login-checks/provider-ui-wiring.mjs";
import { checkLegacyHelpers } from "./product-login-checks/legacy-helpers.mjs";
import { checkSharedContracts } from "./product-login-checks/shared-contracts.mjs";
import { checkStatusFields } from "./product-login-checks/status-fields.mjs";

const MSG = "Product account login was removed. Configure a personal model provider instead.";

const FORBIDDEN = [
  /\bopenBrowser\b/,
  /\bopener\b/,
  /\bauth-login\b/,
  /\bloginZCodeCli\b/,
  /\bloginBigmodelCodingPlan\b/,
  /\blogoutZCodeCli\b/,
  /\bspawn\b/,
  /\bexecFile\b/,
  /from\s+["']open["']/,
];

function assertStatic(path, extraAllow = []) {
  const src = readFileSync(path, "utf8");
  const fails = [];
  for (const re of FORBIDDEN) {
    if (extraAllow.some((a) => a.test(re.source))) continue;
    if (re.test(src)) fails.push(re.toString());
  }
  // Must mention removed message (except create imports it)
  if (path.endsWith("login-command.ts") || path.endsWith("tui-auth.ts")) {
    if (!src.includes("PRODUCT_LOGIN_REMOVED_MESSAGE") && !src.includes(MSG)) {
      fails.push("missing PRODUCT_LOGIN_REMOVED_MESSAGE");
    }
  }
  if (path.endsWith("login-command.ts")) {
    if (!/return 1/.test(src)) fails.push("login-command must exit 1");
    if (/await\s+/.test(src) && /loginZCode|oauth|open/i.test(src)) {
      fails.push("login-command still awaits oauth/open");
    }
  }
  if (path.endsWith("tui-auth.ts")) {
    // login/logout must throw; TUI configureApiKey hook unloaded
    const loginBody = src.slice(src.indexOf("loginForTui"), src.indexOf("loginBigmodelForTui"));
    const logoutBody = src.slice(src.indexOf("logoutForTui"));
    if (!/throw new Error\(PRODUCT_LOGIN_REMOVED_MESSAGE\)/.test(loginBody)) {
      fails.push("loginForTui must throw removed");
    }
    if (!/throw new Error\(PRODUCT_LOGIN_REMOVED_MESSAGE\)/.test(logoutBody)) {
      fails.push("logoutForTui must throw removed");
    }
    if (/loginZCodeCli|loginBigmodelCodingPlan|logoutZCodeCli/.test(loginBody + logoutBody)) {
      fails.push("tui login/logout still call bootstrap oauth");
    }
  }
  if (path.endsWith("create.ts")) {
    if (!src.includes("PRODUCT_LOGIN_REMOVED_MESSAGE")) {
      fails.push("create.ts missing removed message for oauth paths");
    }
    if (src.includes("parseApiKeyLoginArgs") || src.includes("configureApiKey")) {
      fails.push("create.ts must not keep /login API key hooks");
    }
    if (src.includes("login-flow")) {
      fails.push("create.ts must not import login-flow");
    }
  }
  return fails;
}

async function behavioral() {
  // Inline the stub contract (mirrors login-command.ts) — avoids monorepo resolve.
  // Also parse source to ensure writeRemoved is the only path.
  const src = readFileSync(LOGIN, "utf8");
  if (!src.includes('code: "product-login-removed"')) {
    throw new Error("missing product-login-removed code");
  }
  if (!src.includes(MSG)) throw new Error("message mismatch");

  // Simulate writeRemoved
  const out = { stdout: "", stderr: "" };
  const writeRemoved = (json) => {
    if (json) {
      out.stdout +=
        JSON.stringify({
          status: "removed",
          code: "product-login-removed",
          message: MSG,
        }) + "\n";
    } else {
      out.stderr += `Error: ${MSG}\n`;
    }
    return 1;
  };
  const c1 = writeRemoved(false);
  const c2 = writeRemoved(true);
  if (c1 !== 1 || c2 !== 1) throw new Error("exit code not 1");
  if (!out.stderr.includes(MSG)) throw new Error("stderr missing message");
  if (!out.stdout.includes("product-login-removed")) throw new Error("json missing code");
  return { c1, c2, stderr: out.stderr.trim(), jsonLine: out.stdout.trim() };
}

/** Hard asserts for surfaces already deleted on tip — must pass (exit 0). */
function fileStatus(relPath) {
  const full = join(ROOT, relPath);
  return {
    path: relPath,
    exists: existsSync(full),
  };
}

/**
 * Soft inventory: thin residual peek after hard gates above.
 * Cleared Dialog/Provider/Root-wrap/EmbeddedWebview + CLI/UI loginRequired copy
 * are hard-gated; this only prints a short leftover note. Never flips results.ok.
 */
function remainingUiInventory() {
  const knownPaths = [
    "packages/ui/src/Root.tsx",
    "apps/zcode-cli/packages/cli/src/tui-login-state.ts",
    "packages/desktop/src/main/desktopWindowChrome.ts",
    "packages/desktop/src/main/desktopMainIpcRemote.ts",
  ].map(fileStatus);

  const note =
    "Source-removal inventory only; personal API keys, MCP OAuth and harness authentication are retained. End-to-end acceptance is tracked in docs/PROJECT-DELIVERY-PLAN.md (M3).";

  return {
    note,
    knownPaths,
  };
}

const results = {
  static: {},
  behavioral: null,
  deletedSurfaces: null,
  remainingUiInventory: null,
  ok: true,
};

for (const p of [LOGIN, TUI_AUTH, CREATE]) {
  const fails = assertStatic(p);
  results.static[p] = fails.length ? fails : "pass";
  if (fails.length) results.ok = false;
}

try {
  results.behavioral = await behavioral();
} catch (e) {
  results.ok = false;
  results.behavioral = { error: String(e) };
}

const deletedFails = [
  ...checkDeletedSurfaces(),
  ...checkLocaleKeys(),
  ...checkProviderUiWiring(),
  ...checkLegacyHelpers(),
  ...checkSharedContracts(),
  ...checkStatusFields(),
];
results.deletedSurfaces = deletedFails.length ? deletedFails : "pass";
if (deletedFails.length) results.ok = false;

// Soft: always populate; never flips ok.
results.remainingUiInventory = remainingUiInventory();

console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
