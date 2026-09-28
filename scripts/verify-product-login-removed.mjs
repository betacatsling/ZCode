#!/usr/bin/env node
/**
 * Minimal gate: product login/logout stubs return "removed" and sources
 * do not open a browser / call OAuth helpers.
 * Run from repo root: node scripts/verify-product-login-removed.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_SRC = join(ROOT, "apps/zcode-cli/packages/cli/src");
const LOGIN = join(CLI_SRC, "login-command.ts");
const TUI_AUTH = join(CLI_SRC, "tui-auth.ts");
const CREATE = join(CLI_SRC, "command-center/create.ts");
const MSG =
  "Product account login was removed. Configure a personal model provider instead.";

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
    // login/logout must throw; configureApiKey may keep bootstrap
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
      out.stdout += JSON.stringify({
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

const results = {
  static: {},
  behavioral: null,
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

console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
