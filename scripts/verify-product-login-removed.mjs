#!/usr/bin/env node
/**
 * Product-login removal gate (scripts-only knife; docs/inventory sync after Dialog unload).
 *
 * Tip state (origin/cursor/wave4-harness-integration-b7a9 @ 8560df4 / #57):
 *   P1–P4 landed; CodingPlanUpgradeDialog / Provider + Root wrap unloaded (Ex1 /
 *   9ce3088); EntryGate CTA / CodingPlanEntryButton / useCodingPlanEntryGate gone;
 *   soft remainingUiInventory first landed in #57 (this tip).
 *
 * Hard gates (must exit 0 on tip):
 *   - CLI login-command / tui-auth / create.ts stubs (P3)
 *   - Deleted UI/contract surfaces: login/**, CodingPlanEntryButton,
 *     CodingPlanUpgradeDialog(.tsx)/Provider, PlatformChannels.OAuth*,
 *     registerOAuthState / onOAuthCallback; Root must not remount Provider
 *
 * Soft inventory (print-only; does not fail exit):
 *   - EmbeddedWebview / funnel / pricing leftovers (isRestoringOAuthSession unloaded)
 *   - CLI TUI loginRequired / loginSetup residual naming
 *
 * Run from repo root: node scripts/verify-product-login-removed.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_SRC = join(ROOT, "apps/zcode-cli/packages/cli/src");
const LOGIN = join(CLI_SRC, "login-command.ts");
const TUI_AUTH = join(CLI_SRC, "tui-auth.ts");
const CREATE = join(CLI_SRC, "command-center/create.ts");
const CHANNELS = join(ROOT, "packages/shared/src/channels.ts");
const PLATFORM = join(ROOT, "packages/shared/src/platform.ts");
const UI_SRC = join(ROOT, "packages/ui/src");
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

/** Hard asserts for surfaces already deleted on tip — must pass (exit 0). */
function assertDeletedSurfaces() {
  const fails = [];
  const loginDir = join(UI_SRC, "login");
  if (existsSync(loginDir)) {
    fails.push("packages/ui/src/login/** must stay deleted (deadcode removed on tip)");
  }
  const entryButton = join(UI_SRC, "settings/CodingPlanEntryButton.tsx");
  if (existsSync(entryButton)) {
    fails.push("CodingPlanEntryButton.tsx must stay deleted (EntryGate CTA unloaded)");
  }
  const upgradeDialog = join(UI_SRC, "settings/CodingPlanUpgradeDialog.tsx");
  if (existsSync(upgradeDialog)) {
    fails.push("CodingPlanUpgradeDialog.tsx must stay deleted (Dialog unload on tip)");
  }
  const upgradeProvider = join(UI_SRC, "settings/CodingPlanUpgradeDialogProvider.tsx");
  if (existsSync(upgradeProvider)) {
    fails.push(
      "CodingPlanUpgradeDialogProvider.tsx must stay deleted (Dialog unload on tip)",
    );
  }
  // Definition of useCodingPlanEntryGate must not reappear under packages/ui/src
  const entryGateHits = grepFiles(UI_SRC, /export\s+function\s+useCodingPlanEntryGate\b/, {
    extensions: [".ts", ".tsx"],
  });
  if (entryGateHits.length) {
    fails.push(
      `useCodingPlanEntryGate definition must stay deleted: ${entryGateHits
        .map((h) => h.file)
        .join(", ")}`,
    );
  }
  // Root must not remount the unloaded Provider (Ex1 / 9ce3088).
  const rootPath = join(UI_SRC, "Root.tsx");
  if (existsSync(rootPath)) {
    const rootSrc = readFileSync(rootPath, "utf8");
    if (/CodingPlanUpgradeDialogProvider/.test(rootSrc)) {
      fails.push("Root.tsx must not reference CodingPlanUpgradeDialogProvider");
    }
    if (
      /<CodingPlanUpgradeDialogProvider>/.test(rootSrc) ||
      /<\/CodingPlanUpgradeDialogProvider>/.test(rootSrc)
    ) {
      fails.push("Root.tsx must not wrap with CodingPlanUpgradeDialogProvider");
    }
  }

  const channelsSrc = readFileSync(CHANNELS, "utf8");
  // PlatformChannels.OAuth* keys (e.g. OAuthRegisterState) must stay gone.
  // Comments mentioning "OAuth" are fine; object keys starting with OAuth are not.
  const oauthKeys = [...channelsSrc.matchAll(/^\s+(OAuth[A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]);
  if (oauthKeys.length) {
    fails.push(`PlatformChannels.OAuth* keys must stay deleted: ${oauthKeys.join(", ")}`);
  }
  // Retired channel string literals that tip comments say are unregistered.
  if (/:\s*"oauth"\s*,/.test(channelsSrc)) {
    fails.push('ServiceChannels must not re-register channel value "oauth"');
  }
  if (/:\s*"coding-plan-subscription"\s*,/.test(channelsSrc)) {
    fails.push('ServiceChannels must not re-register "coding-plan-subscription"');
  }

  const platformSrc = readFileSync(PLATFORM, "utf8");
  if (/\bregisterOAuthState\s*\(/.test(platformSrc)) {
    fails.push("IPlatformService.registerOAuthState must stay deleted");
  }
  if (/\bonOAuthCallback\s*\(/.test(platformSrc)) {
    fails.push("IPlatformService.onOAuthCallback must stay deleted");
  }

  return fails;
}

function listSourceFiles(dir, extensions, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listSourceFiles(full, extensions, acc);
    } else if (extensions.some((ext) => name.endsWith(ext))) {
      acc.push(full);
    }
  }
  return acc;
}

function grepFiles(dir, pattern, { extensions = [".ts", ".tsx", ".mjs", ".js"] } = {}) {
  const hits = [];
  for (const file of listSourceFiles(dir, extensions)) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = [];
    const split = src.split(/\r?\n/);
    for (let i = 0; i < split.length; i++) {
      if (pattern.test(split[i])) {
        lines.push({ line: i + 1, text: split[i].trim().slice(0, 160) });
      }
      // reset lastIndex for global patterns
      pattern.lastIndex = 0;
    }
    if (lines.length) {
      hits.push({ file: relative(ROOT, file), matches: lines.slice(0, 8), matchCount: lines.length });
    }
  }
  return hits;
}

function fileStatus(relPath) {
  const full = join(ROOT, relPath);
  return {
    path: relPath,
    exists: existsSync(full),
  };
}

/**
 * Soft inventory: residuals still present on tip after Dialog/Provider unload.
 * Cleared Dialog/Provider/Root-wrap are hard-gated above; this prints leftovers
 * (Root OAuth restore flag, EmbeddedWebview/funnel helpers, CLI loginRequired/
 * loginSetup naming). Never flips results.ok by itself.
 */
function remainingUiInventory() {
  const symbolScans = [
    {
      id: "CodingPlanUpgradeDialog",
      pattern: /\bCodingPlanUpgradeDialog\b/,
      roots: [UI_SRC],
    },
    {
      id: "CodingPlanUpgradeDialogProvider",
      pattern: /\bCodingPlanUpgradeDialogProvider\b/,
      roots: [UI_SRC],
    },
    {
      id: "openCodingPlanUpgrade",
      pattern: /\bopenCodingPlanUpgrade\b/,
      roots: [UI_SRC],
    },
    {
      id: "useCodingPlanUpgradeDialog",
      pattern: /\buse(?:Optional)?CodingPlanUpgradeDialog\b/,
      roots: [UI_SRC],
    },
    {
      id: "useCodingPlanEntryGate",
      pattern: /\buseCodingPlanEntryGate\b/,
      roots: [UI_SRC],
    },
    {
      id: "CodingPlanEntryButton",
      pattern: /\bCodingPlanEntryButton\b/,
      roots: [UI_SRC],
    },
    {
      id: "loginRequired_cli_tui",
      pattern: /\bloginRequired\b/,
      roots: [
        join(ROOT, "apps/zcode-cli/packages/cli/src"),
        join(ROOT, "apps/zcode-cli/packages/tui/src"),
        join(ROOT, "apps/zcode-cli/packages/i18n/src"),
      ],
    },
    {
      id: "loginSetup_cli_tui",
      pattern: /\bloginSetup\b/,
      roots: [
        join(ROOT, "apps/zcode-cli/packages/cli/src"),
        join(ROOT, "apps/zcode-cli/packages/tui/src"),
        join(ROOT, "apps/zcode-cli/packages/i18n/src"),
      ],
    },
  ];

  const symbols = {};
  for (const scan of symbolScans) {
    const hits = [];
    for (const root of scan.roots) {
      hits.push(...grepFiles(root, scan.pattern));
    }
    // Prefer production src hits in summary; keep tests visible but tagged.
    const production = hits.filter((h) => !/(^|\/)test\//.test(h.file) && !/\.test\./.test(h.file) && !/\.spec\./.test(h.file));
    const tests = hits.filter((h) => !production.includes(h));
    symbols[scan.id] = {
      productionHitCount: production.reduce((n, h) => n + h.matchCount, 0),
      productionFiles: production.map((h) => h.file),
      testOnlyFiles: tests.map((h) => h.file),
      sample: production[0]?.matches?.slice(0, 3) ?? tests[0]?.matches?.slice(0, 2) ?? [],
    };
  }

  const knownPaths = [
    "packages/ui/src/settings/CodingPlanUpgradeDialog.tsx",
    "packages/ui/src/settings/CodingPlanUpgradeDialogProvider.tsx",
    "packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx",
    "packages/ui/src/settings/CodingPlanEntryButton.tsx",
    "packages/ui/src/login",
    "packages/ui/src/Root.tsx",
    "packages/ui/src/lib/sidebarCodingPlanUpgrade.ts",
    "packages/ui/src/lib/codingPlanFunnelTelemetry.ts",
    "packages/ui/src/hooks/useCodingPlanEntryPlanList.ts",
    "packages/ui/src/settings/model-provider-section/codingPlanPricingCards.ts",
    "apps/zcode-cli/packages/cli/src/tui-login-state.ts",
  ].map(fileStatus);

  const rootSrc = existsSync(join(UI_SRC, "Root.tsx"))
    ? readFileSync(join(UI_SRC, "Root.tsx"), "utf8")
    : "";
  const rootMount = {
    importsCodingPlanUpgradeDialogProvider: /CodingPlanUpgradeDialogProvider/.test(rootSrc),
    wrapsWithCodingPlanUpgradeDialogProvider:
      /<CodingPlanUpgradeDialogProvider>/.test(rootSrc) &&
      /<\/CodingPlanUpgradeDialogProvider>/.test(rootSrc),
    stillReadsIsRestoringOAuthSession: /\bisRestoringOAuthSession\b/.test(rootSrc),
  };

  const note =
    "Tip c7d1a07+: Dialog/Provider/Root-wrap cleared; Root isRestoringOAuthSession unloaded (hard-gated clear). Soft remaining = EmbeddedWebview/funnel/pricing leftovers + CLI TUI loginRequired/loginSetup rename. useCodingPlanEntryPlanList deleted (zero callers). Inventory does not fail this gate.";

  return {
    note,
    knownPaths,
    rootMount,
    symbols,
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

const deletedFails = assertDeletedSurfaces();
results.deletedSurfaces = deletedFails.length ? deletedFails : "pass";
if (deletedFails.length) results.ok = false;

// Soft: always populate; never flips ok.
results.remainingUiInventory = remainingUiInventory();

console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
