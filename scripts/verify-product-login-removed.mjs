#!/usr/bin/env node
/**
 * Product-login removal gate (scripts-only knife; docs/inventory sync after Dialog unload).
 *
 * Tip state (origin/cursor/wave4-harness-integration-b7a9 @ ea7762b / #135):
 *   P1–P4 landed; CodingPlanUpgradeDialog / Provider + Root wrap unloaded (Ex1 /
 *   9ce3088); EntryGate CTA / CodingPlanEntryButton / useCodingPlanEntryGate gone;
 *   soft remainingUiInventory first landed in #57; #103–#135 clearances hard-gated below.
 *
 * Hard gates (must exit 0 on tip):
 *   - CLI login-command / tui-auth / create.ts stubs (P3)
 *   - Deleted UI/contract surfaces: login/**, CodingPlanEntryButton,
 *     CodingPlanUpgradeDialog(.tsx)/Provider, CodingPlanEmbeddedWebviewDialog
 *     (+ codingPlanEmbeddedWebview helpers), PlatformChannels.OAuth*,
 *     registerOAuthState / onOAuthCallback; Root must not remount Provider
 *
 * Soft inventory (print-only; does not fail exit):
 *   - thin residual file-existence peek (most Dialog/Provider/Entry surfaces are hard above)
 *
 * Hard (also): CLI i18n tui.loginRequired / tui.loginSetup key names must stay absent
 *   (renamed to modelSetupRequired / deleted dead loginSetup).
 * Hard (also): CLI isLoginRequired gate must stay absent (renamed to isModelSetupRequired).
 * Hard (also): UI locale dead product loginRequired / Coding Plan login keys must stay absent
 *   (codingPlan.login, productsLoginRequired, start.loginEnable/Trial, entitlement*LoginRequired).
 * Hard (also): orphan Welcome / login.* shell locale keys must stay absent; old
 *   login.oauth.regionTag.* must stay absent (#112 → settings.modelProvider.regionTag.*);
 *   keep conversationShare.import.signInRequired + live personal API-key / MCP OAuth copy.
 * Hard (also): #103–#107 dead upgrade/purchase / usage upgrade-renew / enterprise acquisition
 *   i18n must stay absent.
 * Hard (also): #114 slash-help /login+/logout must not advertise Coding Plan / Z.ai OAuth
 *   acquisition; require model-setup / personal API-key guidance (KEEP MCP help entry).
 * Hard (also): #123 orphan useEnterpriseCodingPlanProducts.ts must stay deleted; #124
 *   productPurchaseRemovedTitle i18n must stay absent (KEEP productPurchaseRemoved body +
 *   manage / planCard / Display types / entitlement).
 * Hard (also): #126 refreshTeamPlanProducts must stay absent from modelProviderActions +
 *   ModelProviderSection (KEEP refreshModelProviderSection / refreshCodingPlanEntitlements).
 * Hard (also): #128 codingPlanUsageSources buildCodingPlanUsageSources must stay collapsed to
 *   return []; dead team flatMap helpers must stay absent (KEEP CodingPlanUsageSource /
 *   buildPersonalCodingPlanUsageSource / resolveSidebarCurrentCodingPlanUsageSource signature).
 * Hard (also): #131–#135+ SettingsPage / V4ComposerToolbar / WorkspaceSidebarFooterUsageSummary /
 *   ModelProviderSection must not revive named empty subscribedTeamProducts =
 *   useMemo(() => [], []) (or usageSubscribedTeamProducts / typed equivalent) and must not
 *   keep subscribedTeamProducts call-site / signature wiring (KEEP entitlement / Display /
 *   manage · planCard / productPurchaseRemoved body).
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
  const embeddedWebviewDialog = join(UI_SRC, "settings/CodingPlanEmbeddedWebviewDialog.tsx");
  if (existsSync(embeddedWebviewDialog)) {
    fails.push(
      "CodingPlanEmbeddedWebviewDialog.tsx must stay deleted (orphan EmbeddedWebview Dialog unload)",
    );
  }
  const embeddedWebviewHelpers = join(
    UI_SRC,
    "settings/model-provider-section/codingPlanEmbeddedWebview.ts",
  );
  if (existsSync(embeddedWebviewHelpers)) {
    fails.push(
      "codingPlanEmbeddedWebview.ts must stay deleted (helpers only used by EmbeddedWebview Dialog)",
    );
  }
  const purchaseAuth = join(
    UI_SRC,
    "settings/model-provider-section/codingPlanPurchaseAuth.ts",
  );
  if (existsSync(purchaseAuth)) {
    fails.push(
      "codingPlanPurchaseAuth.ts must stay deleted (purchase auth stub unload)",
    );
  }
  const pricingCards = join(
    UI_SRC,
    "settings/model-provider-section/codingPlanPricingCards.ts",
  );
  if (existsSync(pricingCards)) {
    fails.push(
      "codingPlanPricingCards.ts must stay deleted (CodingPlanLoginOptions unload)",
    );
  }
  // #123: orphan enterprise products hook must stay deleted (Display/entitlement KEPT).
  const enterpriseProductsHook = join(
    UI_SRC,
    "settings/model-provider-section/useEnterpriseCodingPlanProducts.ts",
  );
  if (existsSync(enterpriseProductsHook)) {
    fails.push(
      "useEnterpriseCodingPlanProducts.ts must stay deleted (orphan hook unload #123)",
    );
  }
  const detailPath = join(UI_SRC, "settings/model-provider-section/Detail.tsx");
  if (existsSync(detailPath)) {
    const detailSrc = readFileSync(detailPath, "utf8");
    if (/CodingPlanPurchaseChoiceBanners|purchaseChoiceBannersVisible|CodingPlanAccessBanner/.test(detailSrc)) {
      fails.push("Detail.tsx must not retain Coding Plan purchase/access banners");
    }
  }
  const codingPlanWebviewPreload = join(
    ROOT,
    "packages/desktop/src/preload/codingPlanWebview.ts",
  );
  if (existsSync(codingPlanWebviewPreload)) {
    fails.push(
      "codingPlanWebview.ts preload must stay deleted (Coding Plan embedded webview unload)",
    );
  }
  const desktopChromePath = join(ROOT, "packages/desktop/src/main/desktopWindowChrome.ts");
  if (existsSync(desktopChromePath)) {
    const chromeSrc = readFileSync(desktopChromePath, "utf8");
    if (/isCodingPlanEmbeddedWebviewSrc|codingPlanWebviewPreloadPath|isCodingPlanPaypalNavigationUrl/.test(chromeSrc)) {
      fails.push(
        "desktopWindowChrome.ts must not retain Coding Plan embedded/PayPal special cases",
      );
    }
  }
  const desktopHandlersPath = join(ROOT, "packages/desktop/src/main/desktopCommandHandlers.ts");
  if (existsSync(desktopHandlersPath)) {
    const handlersSrc = readFileSync(desktopHandlersPath, "utf8");
    if (/clearCodingPlanWebviewStorage|CODING_PLAN_WEBVIEW_PARTITION|persist:zcode-coding-plan/.test(handlersSrc)) {
      fails.push(
        "desktopCommandHandlers.ts must not retain clearCodingPlanWebviewStorage / coding-plan partition",
      );
    }
  }
  const sharedPlatformPath = join(ROOT, "packages/shared/src/platform.ts");
  if (existsSync(sharedPlatformPath)) {
    const platformSrc = readFileSync(sharedPlatformPath, "utf8");
    if (/ClearCodingPlanWebviewStorage/.test(platformSrc)) {
      fails.push("DesktopCommandIds.ClearCodingPlanWebviewStorage must stay deleted");
    }
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

  // CLI i18n: loginRequired / loginSetup key names renamed/removed (Ex3 thin knife).
  const i18nSrc = join(ROOT, "apps/zcode-cli/packages/i18n/src");
  const staleKeyHits = [
    ...grepFiles(i18nSrc, /\bloginRequired\s*:/, { extensions: [".ts"] }),
    ...grepFiles(i18nSrc, /\bloginSetup\s*:/, { extensions: [".ts"] }),
  ];
  if (staleKeyHits.length) {
    fails.push(
      `CLI i18n must not keep loginRequired/loginSetup keys: ${staleKeyHits
        .map((h) => h.file)
        .join(", ")}`,
    );
  }
  const modelSetupHits = grepFiles(i18nSrc, /\bmodelSetupRequired\s*:/, {
    extensions: [".ts"],
  });
  if (!modelSetupHits.length) {
    fails.push("CLI i18n must define modelSetupRequired (renamed from loginRequired)");
  }

  // CLI command-center gate: isLoginRequired → isModelSetupRequired (Ex3 Track B).
  const cliSrc = join(ROOT, "apps/zcode-cli/packages/cli/src");
  const staleGateHits = grepFiles(cliSrc, /\bisLoginRequired\b/, { extensions: [".ts"] });
  if (staleGateHits.length) {
    fails.push(
      `CLI must not keep isLoginRequired gate: ${staleGateHits.map((h) => h.file).join(", ")}`,
    );
  }
  const modelGateHits = grepFiles(cliSrc, /\bisModelSetupRequired\b/, { extensions: [".ts"] });
  if (!modelGateHits.length) {
    fails.push("CLI must define isModelSetupRequired gate (renamed from isLoginRequired)");
  }

  // UI i18n: dead product-login / Coding Plan /login locale keys (Ex3 thin knife).
  const uiLocaleDir = join(UI_SRC, "i18n/locales");
  const deadUiLoginKeys = [
    "settings.modelProvider.codingPlan.login",
    "settings.modelProvider.codingPlan.productsLoginRequired",
    "settings.modelProvider.codingPlan.start.loginEnable",
    "settings.modelProvider.codingPlan.start.loginTrial",
    "settings.usage.entitlementLoginRequired",
    "settings.usage.entitlementStatusLoginRequired",
    "sidebar.usage.plan.loginRequired",
    // #104 usage-panel upgrade/renew residue
    "sidebar.usage.plan.upgrade",
    "sidebar.usage.plan.renew",
    // #103 dead Coding Plan upgrade/purchase CTA strings
    "settings.modelProvider.codingPlan.subscribe",
    "settings.modelProvider.codingPlan.upgrade",
    "settings.modelProvider.codingPlan.renew",
    "settings.modelProvider.codingPlan.currentPlan",
    "settings.modelProvider.codingPlan.cancelUpgrade",
    "settings.modelProvider.codingPlan.purchase.individualsSectionTitle",
    "settings.modelProvider.codingPlan.purchaseBanner.startPlanTitle",
    "settings.modelProvider.codingPlan.purchase.selectPlan",
    // #124: Title orphan after Automations toast (#121); KEEP productPurchaseRemoved body
    "settings.modelProvider.codingPlan.productPurchaseRemovedTitle",
    // #112: old botsUi regionTag path must stay absent (moved off login.oauth)
    "login.oauth.regionTag.zai",
    "login.oauth.regionTag.bigmodel",
    // Orphan Welcome / login.* shell (Ex3 / #111); KEEP settings.modelProvider.regionTag.*
    "welcome.username",
    "welcome.password",
    "welcome.login",
    "welcome.loggingIn",
    "welcome.loginFailed",
    "login.title",
    "login.description",
    "login.oauth.activeProviderHint",
    "login.oauth.loadingProviders",
    "login.oauth.noProviders",
    "login.oauth.button",
    "login.oauth.button.zai",
    "login.oauth.button.bigmodel",
    "login.oauth.waiting",
    "login.oauth.loginFailure",
    "login.oauth.cancel",
    "login.oauth.retry",
    "login.expired.title",
    "login.expired.description",
    "login.expired.action",
    "login.expired.restart",
    "login.useApiKey",
    "login.apiKey.title",
    "login.apiKey.placeholder",
    "login.apiKey.providerLabel",
    "login.apiKey.provider.zai",
    "login.apiKey.provider.bigmodel",
    "login.apiKey.getApiKey",
    "login.apiKey.cancel",
    "login.apiKey.continue",
    "login.apiKey.emptyError",
    "login.apiKey.providerMissingError",
    "login.apiKey.saveError",
    "login.apiKey.skipError",
    "login.skip",
  ];
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const key of deadUiLoginKeys) {
    const keyHits = grepFiles(uiLocaleDir, new RegExp(`"${escapeRegExp(key)}"`), {
      extensions: [".ts"],
    });
    if (keyHits.length) {
      fails.push(
        `UI locales must not keep dead product-login key ${key}: ${keyHits
          .map((h) => h.file)
          .join(", ")}`,
      );
    }
  }
  // Legitimate ZCode account sign-in copy (share-import) must remain.
  const signInHits = grepFiles(uiLocaleDir, /"conversationShare\.import\.signInRequired"/, {
    extensions: [".ts"],
  });
  if (signInHits.length < 2) {
    fails.push(
      "UI locales must keep conversationShare.import.signInRequired (ZCode account, not product login)",
    );
  }
  // Live bot region tags (#112): must remain under settings.modelProvider.regionTag.*.
  for (const keepKey of [
    "settings.modelProvider.regionTag.zai",
    "settings.modelProvider.regionTag.bigmodel",
  ]) {
    const keepHits = grepFiles(uiLocaleDir, new RegExp(`"${escapeRegExp(keepKey)}"`), {
      extensions: [".ts"],
    });
    if (keepHits.length < 2) {
      fails.push(`UI locales must keep live ${keepKey} (botsUi region tags)`);
    }
  }
  // #107 enterprise / overseasPayment / paymentDialog / start / product / securityVerification
  // acquisition prefixes must stay absent (keep manage / planCard / productPurchaseRemoved).
  const deadAcquisitionPrefixes = [
    "settings.modelProvider.codingPlan.enterprise.",
    "settings.modelProvider.codingPlan.overseasPayment.",
    "settings.modelProvider.codingPlan.paymentDialog.",
    "settings.modelProvider.codingPlan.start.",
    "settings.modelProvider.codingPlan.product.",
    "settings.modelProvider.codingPlan.securityVerification",
  ];
  for (const localeFile of ["en-US.ts", "zh-CN.ts"]) {
    const localePath = join(uiLocaleDir, localeFile);
    if (!existsSync(localePath)) {
      fails.push(`missing UI locale ${localeFile}`);
      continue;
    }
    const localeSrc = readFileSync(localePath, "utf8");
    for (const prefix of deadAcquisitionPrefixes) {
      if (localeSrc.includes(`"${prefix}`)) {
        fails.push(`UI locales must not keep dead acquisition prefix ${prefix} in ${localeFile}`);
      }
    }
    for (const keepKey of [
      "settings.modelProvider.codingPlan.manage",
      "settings.modelProvider.codingPlan.productPurchaseRemoved",
      "settings.modelProvider.planCard.codingPlan",
      "settings.modelProvider.planCard.startPlan",
    ]) {
      if (!localeSrc.includes(`"${keepKey}"`)) {
        fails.push(`UI locales must keep ${keepKey} in ${localeFile}`);
      }
    }
  }
  // #104: oauthProviderIcon unknown-provider fallback must not revive LogIn glyph.
  const oauthIconPath = join(UI_SRC, "lib/oauthProviderIcon.tsx");
  if (existsSync(oauthIconPath)) {
    const oauthIconSrc = readFileSync(oauthIconPath, "utf8");
    if (/\bLogInIcon\b/.test(oauthIconSrc)) {
      fails.push("oauthProviderIcon must not use LogInIcon (usage-panel residue #104)");
    }
  }

  // #126: refreshTeamPlanProducts hard-absent after enterprise products removal.
  // KEEP refreshModelProviderSection + refreshCodingPlanEntitlements / Display wiring.
  const modelProviderActionsPath = join(
    UI_SRC,
    "settings/model-provider-section/modelProviderActions.ts",
  );
  if (!existsSync(modelProviderActionsPath)) {
    fails.push("modelProviderActions.ts must exist");
  } else {
    const actionsSrc = readFileSync(modelProviderActionsPath, "utf8");
    if (/\brefreshTeamPlanProducts\b/.test(actionsSrc)) {
      fails.push(
        "modelProviderActions.ts must not retain refreshTeamPlanProducts (#126)",
      );
    }
    if (!/\brefreshModelProviderSection\b/.test(actionsSrc)) {
      fails.push("modelProviderActions.ts must keep refreshModelProviderSection");
    }
    if (!/\brefreshCodingPlanEntitlements\b/.test(actionsSrc)) {
      fails.push(
        "modelProviderActions.ts must keep refreshCodingPlanEntitlements (entitlement KEPT)",
      );
    }
  }
  const modelProviderSectionPath = join(UI_SRC, "settings/ModelProviderSection.tsx");
  if (existsSync(modelProviderSectionPath)) {
    const sectionSrc = readFileSync(modelProviderSectionPath, "utf8");
    if (/\brefreshTeamPlanProducts\b/.test(sectionSrc)) {
      fails.push(
        "ModelProviderSection.tsx must not wire refreshTeamPlanProducts (#126)",
      );
    }
    if (/\brefreshAuthenticatedEnterpriseProducts\b/.test(sectionSrc)) {
      fails.push(
        "ModelProviderSection.tsx must not wire refreshAuthenticatedEnterpriseProducts (#126)",
      );
    }
  }

  // #128: codingPlanUsageSources dead team-products flatMap thinned to return [].
  // Do not rewrite Ex1 source here — only gate tip reality. KEEP public signature /
  // CodingPlanUsageSource / personal builder / sidebar resolver.
  const usageSourcesPath = join(UI_SRC, "lib/codingPlanUsageSources.ts");
  if (!existsSync(usageSourcesPath)) {
    fails.push("codingPlanUsageSources.ts must exist");
  } else {
    const usageSrc = readFileSync(usageSourcesPath, "utf8");
    if (!/\bexport function buildCodingPlanUsageSources\b/.test(usageSrc)) {
      fails.push("codingPlanUsageSources must keep buildCodingPlanUsageSources signature");
    }
    if (!/\bexport interface CodingPlanUsageSource\b/.test(usageSrc)) {
      fails.push("codingPlanUsageSources must keep CodingPlanUsageSource type");
    }
    if (!/\bexport function buildPersonalCodingPlanUsageSource\b/.test(usageSrc)) {
      fails.push("codingPlanUsageSources must keep buildPersonalCodingPlanUsageSource");
    }
    if (!/\bexport function resolveSidebarCurrentCodingPlanUsageSource\b/.test(usageSrc)) {
      fails.push(
        "codingPlanUsageSources must keep resolveSidebarCurrentCodingPlanUsageSource",
      );
    }
    // Collapsed body: return [] (allow whitespace / comment noise between braces).
    if (!/buildCodingPlanUsageSources[\s\S]*?\{[\s\S]*?return\s*\[\s*\]\s*;/.test(usageSrc)) {
      fails.push(
        "buildCodingPlanUsageSources must stay collapsed to return [] (#128)",
      );
    }
    const deadUsageHelpers = [
      "buildTeamCodingPlanUsageSources",
      "formatTeamUsageSourceLabel",
      "subscribedTeamProducts.flatMap",
      "formatTeamPlanDisplayName",
      "resolveEnterpriseCodingPlanProductFamily",
    ];
    for (const dead of deadUsageHelpers) {
      if (usageSrc.includes(dead)) {
        fails.push(
          `codingPlanUsageSources must not revive dead team flatMap helper/path: ${dead} (#128)`,
        );
      }
    }
  }

  // #131–#135+: named empty subscribedTeamProducts useMemo stubs and literal
  // subscribedTeamProducts call sites must stay unloaded (nav/visibility params dropped).
  // KEEP entitlement / Display / manage · planCard / productPurchaseRemoved body.
  const emptyTeamProductsUseMemoRe =
    /\b(?:usage)?[Ss]ubscribedTeamProducts\s*=\s*useMemo(?:<[^>]*>)?\s*\(\s*\(\s*\)\s*=>\s*\[\s*\]\s*,\s*\[\s*\]\s*\)/;
  const teamStubFiles = [
    ["SettingsPage.tsx", "SettingsPage.tsx"],
    ["v4/composer/V4ComposerToolbar.tsx", "V4ComposerToolbar.tsx"],
    ["WorkspaceSidebarFooterUsageSummary.tsx", "WorkspaceSidebarFooterUsageSummary.tsx"],
    ["settings/ModelProviderSection.tsx", "ModelProviderSection.tsx"],
  ];
  for (const [rel, label] of teamStubFiles) {
    const stubPath = join(UI_SRC, rel);
    if (!existsSync(stubPath)) {
      fails.push(`${label} must exist (#131–#135 gate)`);
      continue;
    }
    const stubSrc = readFileSync(stubPath, "utf8");
    if (emptyTeamProductsUseMemoRe.test(stubSrc)) {
      fails.push(
        `${label} must not contain named empty subscribedTeamProducts useMemo stub (#131–#135)`,
      );
    }
    if (/\bsubscribedTeamProducts\b/.test(stubSrc)) {
      fails.push(
        `${label} must not keep subscribedTeamProducts call-site / signature wiring`,
      );
    }
  }

  // #114: slash-help /login+/logout rewritten off Coding Plan / Z.ai OAuth acquisition.
  // KEEP MCP (and other non-login) help entries unchanged.
  const slashHelpPath = join(ROOT, "packages/shared/src/zcode-slash-command-help.ts");
  if (!existsSync(slashHelpPath)) {
    fails.push("packages/shared/src/zcode-slash-command-help.ts must exist");
  } else {
    const slashHelpSrc = readFileSync(slashHelpPath, "utf8");
    const forbiddenSlashHelpPhrases = [
      "Opens a Coding Plan setup picker",
      "Z.ai and BigModel browser login",
      "Manual API key variants accept the API key as an argument",
      "Set up a Coding Plan provider",
      "Deletes Z.ai OAuth credentials",
      "Remove the shared Z.ai login credentials",
      "zai-coding-plan",
      "bigmodel-coding-plan",
      "zai-coding-plan-api-key",
      "bigmodel-coding-plan-api-key",
    ];
    for (const phrase of forbiddenSlashHelpPhrases) {
      if (slashHelpSrc.includes(phrase)) {
        fails.push(
          `slash-help must not retain Coding Plan / product OAuth acquisition phrase: ${phrase}`,
        );
      }
    }
    // Require model-setup / personal API-key style guidance (post-#114 rewrite).
    const requiredSlashHelpSnippets = [
      "Product account login was removed",
      "model setup",
      "API key",
      "Product account logout was removed",
    ];
    for (const snippet of requiredSlashHelpSnippets) {
      if (!slashHelpSrc.includes(snippet)) {
        fails.push(
          `slash-help must keep model-setup / API-key guidance snippet: ${snippet}`,
        );
      }
    }
    // KEEP MCP help entry (unchanged by #114).
    if (!/name:\s*"mcp"/.test(slashHelpSrc) || !/\bMCP\b/.test(slashHelpSrc)) {
      fails.push("slash-help must keep MCP command help entry");
    }
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
    "Tip ea7762b (#135 / after #103–#134): Dialog/Provider/Entry/EmbeddedWebview + CLI loginRequired→modelSetupRequired hard. UI locale dead product loginRequired / Coding Plan login + orphan Welcome/login.* shell + #103–#107 upgrade/purchase/usage/enterprise acquisition i18n hard-gated. login.oauth.regionTag.* absent; KEEP settings.modelProvider.regionTag.* + share-import signInRequired + manage/planCard + productPurchaseRemoved body + live personal API-key / MCP OAuth copy. #114 slash-help /login+/logout off Coding Plan/Z.ai OAuth acquisition → model-setup/API-key guidance hard-gated (KEEP MCP help). #123 useEnterpriseCodingPlanProducts.ts hard-absent; #124 productPurchaseRemovedTitle absent; #126 refreshTeamPlanProducts hard-absent (KEEP entitlement refresh); #128 usageSources buildCodingPlanUsageSources → return [] / dead flatMap helpers absent (KEEP CodingPlanUsageSource / personal builder / sidebar resolver); #131–#135+ Settings/V4/sidebar/MPS subscribedTeamProducts useMemo stubs and call sites hard-absent. Soft inventory thinned — cleared symbol scans dropped. Inventory does not fail this gate.";

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

const deletedFails = assertDeletedSurfaces();
results.deletedSurfaces = deletedFails.length ? deletedFails : "pass";
if (deletedFails.length) results.ok = false;

// Soft: always populate; never flips ok.
results.remainingUiInventory = remainingUiInventory();

console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
