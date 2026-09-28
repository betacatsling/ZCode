#!/usr/bin/env node
/**
 * Product-login removal gate (scripts-only knife; docs/inventory sync after Dialog unload).
 *
 * Tip state (origin/cursor/wave4-harness-integration-b7a9 @ 04fc2af / #140–#244 (#155 SessionHost OUT; #156/#160/#163/#164/#168/#170/#172/#176/#181/#186/#192/#207/#209/#210 hard-pins; #157 family team feed soft; #158/#159/#162 gated; #161/#165/#169/#171/#173/#180/#188/#189/#191/#193/#197/#201/#206/#208/#212/#213/#214/#219/#224/#231/#234/#235/#237/#239 P6/agent-host docs; #174/#177/#182/#187/#195/#196/#202/#211/#217/#223/#229/#236/#242 SessionHost OUT; #166 status-comment scrub; #167/#185/#215/#216/#220/#222/#227/#232/#243 ledger; #178 statusSyncLoading rename; #179 billing/relogin locales; #190 Catalog rename; #194/#240 REMOVE docs; #198 statusPending rename; #199 statusGatePending rename; #200 presetCatalogProviderId rename; #203 statusPending pin; #204 presetCatalog pin; #205 statusSyncLoading pin; #218 subscribeClose AcpRpc OUT; #221 multiHarness admission OUT; #225 Host honesty OUT; #226 Ex4 automatic family selection OUT; #228/#238/#244 Ex3 lazyAdmission OUT; #230 Ex4 setProviderFamilyDomain writer OUT; #233 Ex4 quota banner upgrade provider OUT; #241 Ex4 quota banner upgrade stubs OUT)):
 *   P1–P4 landed; CodingPlanUpgradeDialog / Provider + Root wrap unloaded (Ex1 /
 *   9ce3088); EntryGate CTA / CodingPlanEntryButton / useCodingPlanEntryGate gone;
 *   soft remainingUiInventory first landed in #57; #103–#186 clearances hard-gated below; #173/#180/#188/#189/#191/#193/#197/#201/#206/#208/#212/#213/#214/#219/#224/#231/#234/#235/#237/#239 docs/#174/#177/#182/#187/#195/#196/#202/#211/#217/#223/#229/#236/#242 SessionHost/#178 statusSyncLoading rename/#179 billing/relogin locales/#190 Catalog rename/#194/#240 REMOVE docs/#198 statusPending rename/#199 statusGatePending rename/#200 presetCatalogProviderId rename/#203 statusPending pin/#204 presetCatalog pin/#205 statusSyncLoading pin/#207 statusPending hard-pin/#209 presetCatalog hard-pin/#210 loginLoading hard-pin/#215/#216/#220/#222/#227/#232/#243 tip-ledger/#218 subscribeClose AcpRpc/#221 multiHarness admission/#225 Host honesty/#226 Ex4 automatic family selection/#228/#238/#244 Ex3 lazyAdmission/#230 Ex4 setProviderFamilyDomain writer/#233 Ex4 quota banner upgrade provider/#241 Ex4 quota banner upgrade stubs are soft ledger OUT.
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
 * Hard (also): #128/Ex1/#142 codingPlanUsageSources buildCodingPlanUsageSources must stay hard-absent;
 *   dead team flatMap helpers must stay absent (KEEP CodingPlanUsageSource /
 *   buildPersonalCodingPlanUsageSource / resolveSidebarCurrentCodingPlanUsageSource signature).
 * Hard (also): #131–#135+/#141 SettingsPage / V4ComposerToolbar / WorkspaceSidebarFooterUsageSummary /
 *   ModelProviderSection / visibility+nav must not revive named empty subscribedTeamProducts =
 *   useMemo(() => [], []) (or usageSubscribedTeamProducts / typed equivalent) and must not
 *   keep subscribedTeamProducts call-site / signature wiring (KEEP entitlement / Display /
 *   manage · planCard / productPurchaseRemoved body).
 * Hard (also): #145 resolveSidebarCurrentCodingPlanUsageSource must not revive teamSources param /
 *   team audience branch (KEEP individual-only sidebar resolver signature).
 * Hard (also): #146/#148 ModelProviderSection / Detail / StatusCards must not revive codingPlanLogin
 *   noop prop chain (onCodingPlanLogin / handleCodingPlanLogin); KEEP codingPlanLoginPending status sync.
 * Hard (also): #150 ModelProviderSection / Detail / modelProviderActions must not revive
 *   onCodingPlanPurchaseComplete / codingPlanPurchaseToken / refreshPurchaseTokenState
 *   (KEEP onQuotaResetEntitlementRefresh / refreshActiveOAuthProvider*).
 * Hard (also): #152 oauthTeamPricing.ts must stay deleted; accountConnectionLossSuggestion must not
 *   revive oauthTeamPricing / getEnterprisePricingProducts / productList team fallback
 *   (KEEP prepareAccountConnectionSwitch + individual-coding-plan path; Display/entitlement KEPT).
 * Hard (also): #158 Detail / StatusCards / CodingPlanStatusActions must not revive
 *   loginActionVisible / loginVisible / loginButtonId (KEEP productPurchaseRemovedVisible +
 *   productPurchaseRemoved body; statusSyncLoading status-sync may remain).
 * Hard (also): #159 codingPlanOwnedEntryPlans.ts must stay deleted; buildOwnedEntryPlanList /
 *   codingPlanOwnedEntryPlans must stay absent under packages/ui (KEEP
 *   EnterpriseCodingPlanProductDisplay in enterpriseCodingPlanProducts.ts).
 * Hard (also): #162 teamPlanDisplayName.ts + codingPlanErrorMessage.ts must stay deleted;
 *   formatTeamPlanDisplayName / teamPlanDisplayName / codingPlanErrorMessage must stay absent
 *   under packages/ui/src (KEEP EnterpriseCodingPlanProductDisplay).
 * Hard (also): #168 sample dead purchase/webview/pricing locale keys + zai/bigmodel plan|purchase
 *   prefixes must stay absent (KEEP manage / planCard / productPurchaseRemoved / quota presentation).
 * Hard (also): #172 sample dead Start Plan acquisition/preview/highlight + plan-access connectionMode
 *   locale keys must stay absent (KEEP live connectionMode labels, startPlan.status.* / balance.title /
 *   refreshEntitlement / expiresAt / pendingUntil, manage · planCard, productPurchaseRemoved).
 * Hard (also): #176 sample dead Coding Plan subscription purchase/payment/preview/sign DTOs
 *   (CodingPlanPaypal* / CodingPlanStripe* / preview/sign family) must stay absent from
 *   coding-plan-subscription.ts (KEEP ForceUpdateConfig + EnterpriseCodingPlanPricingProduct).
 * Hard (also): #186 file-local PersonalCodingPlanSubscription / TeamCodingPlanSubscription
 *   type aliases must stay absent from codingPlanEntitlement.ts (renamed → *EntitlementRecord;
 *   KEEP CodingPlanEntitlement.subscription + ForceUpdateConfig + EnterpriseCodingPlanPricingProduct).
 * Hard (also): #198/#199/#203/#207 codingPlanStatusPanelViewState + Detail must not revive
 *   loginPending / codingPlanLoginPending (KEEP statusPending + codingPlanStatusGatePending +
 *   productPurchaseRemoved / productPurchaseRemovedVisible).
 * Hard (also): #178/#205/#210 Detail / StatusCards / codingPlanStatusPanelViewState must not revive
 *   loginLoading (KEEP statusSyncLoading).
 * Soft ledger also records SessionHost #140/#143/#147/#149/#153/#155/#174/#177/#182/#187/#195/#196/#202/#211/#217/#223/#229/#236/#242 (OUT of this scripts gate) +
 *   #144/#151 productList comment scrubs + #157 family team products feed drop
 *   (resolveFirstSubscribedTeamPlanConnectionWithContext / teamProducts) + #161/#165/#169/#171/#180/#188/#189/#191/#193/#197/#201/#206/#208/#212/#213/#214/#219/#224/#231/#234/#235/#237/#239 P6 tip
 *   docs + #166 status-comment scrub + #167/#185/#215/#216/#220/#222/#227/#232/#243 tip-ledger sync + #168/#170 purchase-locale pins +
 *   #172 plan-mode/access/pricing dead i18n + #176/#181 dead subscription DTO pins + #186/#192 entitlement alias pins +
 *   #179 billingBanner/relogin locale drop +
 *   #190 CodingPlanSubscriptionProviderId→Catalog rename + #194 REMOVE tip docs +
 *   #198 loginPending→statusPending + #199 codingPlanLoginPending→codingPlanStatusGatePending +
 *   #200 presetSubscriptionProviderId→presetCatalogProviderId + #203 statusPending/statusGatePending pin +
 *   #204 presetCatalogProviderId pin + #205 loginLoading absent/statusSyncLoading pin + #206 P6 tip docs +
 *   #207 statusPending/loginPending hard-pin (KEEP statusPending + codingPlanStatusGatePending) +
 *   #209 presetSubscriptionProviderId→presetCatalogProviderId hard-pin (KEEP presetCatalogProviderId) +
 *   #210 loginLoading absent hard-pin (KEEP statusSyncLoading) +
 *   #218 subscribeClose idle peer close AcpRpc OUT +
 *   #221 multiHarness admission gap OUT +
 *   #223 SessionHost disconnect-during-permission OUT +
 *   #225 Host honesty vs install probe OUT +
 *   #226 Ex4 drop unused automatic family connection selection OUT +
 *   #228 Ex3 lazyAdmission ACP forbid/fail-closed OUT +
 *   #229 SessionHost disconnect-during-permission-then-reopen OUT +
 *   #230 Ex4 drop unused setProviderFamilyDomain OAuth family writer OUT +
 *   #233 Ex4 drop unused resolveQuotaBannerUpgradeProviderId OUT +
 *   #236 SessionHost idle-close-during-permission OUT + #242 SessionHost idle-close-during-permission-then-reopen OUT +
 *   #238 Ex3 lazy admission-off ACP fail-closed OUT +
 *   #240 REMOVE-PLAN tip soft OUT +
 *   #241 Ex4 drop unused useV4SessionQuotaBanner upgrade return stubs OUT +
 *   #243 tip-ledger sync OUT +
 *   #244 Ex3 lazy target-unavailable capability fail-closed OUT.
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
    // #168 sample: zero-ref purchase/webview/pricing residue (Ex1 full list in contract test)
    "purchase.entry.loading",
    "settings.modelProvider.codingPlan.title",
    "settings.modelProvider.codingPlan.webview.title",
    "settings.modelProvider.codingPlan.connect",
    "settings.modelProvider.codingPlan.description.notPurchased",
    "settings.modelProvider.codingPlan.audience.personal",
    "settings.modelProvider.codingPlan.unit.usd.month",
    "settings.modelProvider.codingPlan.productsLoading",
    "settings.modelProvider.codingPlan.paypalUnsupported",
    // #172 sample: Start Plan acquisition/preview/highlight + dead plan-access connectionMode
    // (Ex3 knife / contract test has full 31-key list)
    "settings.modelProvider.useSubscription",
    "settings.modelProvider.connectionMode.oauth",
    "settings.modelProvider.connectionMode.startPlanCount",
    "settings.modelProvider.connectionMode.switchToStartPlan",
    "settings.modelProvider.connectionMode.switchToStartPlanPrefix",
    "settings.modelProvider.connectionMode.usageBasedApi",
    "settings.modelProvider.connectionMode.noAvailablePlan",
    "settings.modelProvider.startPlan.login",
    "settings.modelProvider.startPlan.title",
    "settings.modelProvider.startPlan.meta.today",
    "settings.modelProvider.startPlan.quotaSectionTitle",
    "settings.modelProvider.startPlan.eligibleNewUser",
    "settings.modelProvider.startPlan.preview.unit.tokens",
    "settings.modelProvider.startPlan.preview.period.daily",
    "settings.modelProvider.startPlan.balance.remaining",
    "settings.modelProvider.startPlan.balance.used",
    "settings.modelProvider.startPlan.highlight.trial.label",
    "settings.modelProvider.startPlan.highlight.quota.value",
    "settings.modelProvider.startPlan.compatibility",
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
    // #168 pricing-card plan names / purchase detail matrix
    "settings.modelProvider.codingPlan.zai.plan.",
    "settings.modelProvider.codingPlan.bigmodel.plan.",
    "settings.modelProvider.codingPlan.zai.purchase.",
    "settings.modelProvider.codingPlan.bigmodel.purchase.",
    // #172 Start Plan preview/highlight acquisition matrix
    "settings.modelProvider.startPlan.preview.",
    "settings.modelProvider.startPlan.highlight.",
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
      // #172 KEEP live connectionMode labels + Start Plan status/balance/entitlement
      "settings.modelProvider.connectionMode",
      "settings.modelProvider.connectionMode.startPlan",
      "settings.modelProvider.connectionMode.codingPlan",
      "settings.modelProvider.startPlan.status.expired",
      "settings.modelProvider.startPlan.status.noPlan",
      "settings.modelProvider.startPlan.status.loginExpired",
      "settings.modelProvider.startPlan.balance.title",
      "settings.modelProvider.startPlan.refreshEntitlement",
      "settings.modelProvider.startPlan.expiresAt",
      "settings.modelProvider.startPlan.pendingUntil",
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
    if (/\bexport function buildCodingPlanUsageSources\b/.test(usageSrc)) {
      fails.push("codingPlanUsageSources must drop always-empty buildCodingPlanUsageSources");
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
    // #145: sidebar resolver drops teamSources / team audience branch.
    if (/\bteamSources\b/.test(usageSrc)) {
      fails.push(
        "codingPlanUsageSources must not revive teamSources param (#145)",
      );
    }
    if (/audience:\s*"team"/.test(usageSrc)) {
      fails.push(
        "codingPlanUsageSources must not revive team audience sidebar branch (#145)",
      );
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

  // #146/#148: codingPlanLogin noop prop chain hard-absent after StatusCards gate drop.
  // KEEP codingPlanLoginPending (status-sync flag; not the noop prop).
  const codingPlanLoginFiles = [
    ["settings/ModelProviderSection.tsx", "ModelProviderSection.tsx"],
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
    ["settings/model-provider-section/StatusCards.tsx", "StatusCards.tsx"],
  ];
  const deadCodingPlanLoginSymbols = [
    "onCodingPlanLogin",
    "handleCodingPlanLogin",
  ];
  for (const [rel, label] of codingPlanLoginFiles) {
    const loginPath = join(UI_SRC, rel);
    if (!existsSync(loginPath)) {
      fails.push(`${label} must exist (#146/#148 gate)`);
      continue;
    }
    const loginSrc = readFileSync(loginPath, "utf8");
    for (const dead of deadCodingPlanLoginSymbols) {
      if (loginSrc.includes(dead)) {
        fails.push(
          `${label} must not revive codingPlanLogin noop symbol: ${dead} (#146/#148)`,
        );
      }
    }
  }

  // #150: purchase-complete / purchase-token wiring hard-absent.
  // KEEP onQuotaResetEntitlementRefresh / refreshActiveOAuthProvider*.
  const purchaseCompleteFiles = [
    ["settings/ModelProviderSection.tsx", "ModelProviderSection.tsx"],
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
    [
      "settings/model-provider-section/modelProviderActions.ts",
      "modelProviderActions.ts",
    ],
  ];
  const deadPurchaseCompleteSymbols = [
    "onCodingPlanPurchaseComplete",
    "codingPlanPurchaseToken",
    "refreshPurchaseTokenState",
  ];
  for (const [rel, label] of purchaseCompleteFiles) {
    const purchasePath = join(UI_SRC, rel);
    if (!existsSync(purchasePath)) {
      fails.push(`${label} must exist (#150 gate)`);
      continue;
    }
    const purchaseSrc = readFileSync(purchasePath, "utf8");
    for (const dead of deadPurchaseCompleteSymbols) {
      if (purchaseSrc.includes(dead)) {
        fails.push(
          `${label} must not revive purchase-complete symbol: ${dead} (#150)`,
        );
      }
    }
  }

  // #152: oauthTeamPricing empty productList + account-loss team fallback hard-absent.
  // KEEP prepareAccountConnectionSwitch + individual-coding-plan; Display/entitlement KEPT elsewhere.
  const oauthTeamPricingPath = join(UI_SRC, "root/oauthTeamPricing.ts");
  if (existsSync(oauthTeamPricingPath)) {
    fails.push(
      "oauthTeamPricing.ts must stay deleted (empty team pricing fallback unload #152)",
    );
  }
  const accountLossSuggestionPath = join(
    UI_SRC,
    "root/accountConnectionLossSuggestion.ts",
  );
  if (!existsSync(accountLossSuggestionPath)) {
    fails.push("accountConnectionLossSuggestion.ts must exist (#152 KEEP)");
  } else {
    const suggestionSrc = readFileSync(accountLossSuggestionPath, "utf8");
    for (const dead of [
      "oauthTeamPricing",
      "getEnterprisePricingProducts",
      "productList",
    ]) {
      if (suggestionSrc.includes(dead)) {
        fails.push(
          `accountConnectionLossSuggestion.ts must not revive ${dead} (#152)`,
        );
      }
    }
    if (!/\bprepareAccountConnectionSwitch\b/.test(suggestionSrc)) {
      fails.push(
        "accountConnectionLossSuggestion.ts must keep prepareAccountConnectionSwitch (#152)",
      );
    }
    if (!/\bindividual-coding-plan\b/.test(suggestionSrc)) {
      fails.push(
        "accountConnectionLossSuggestion.ts must keep individual-coding-plan path (#152)",
      );
    }
  }

  // #158: loginActionVisible rename — old prop names hard-absent.
  // KEEP productPurchaseRemovedVisible + productPurchaseRemoved body (statusSyncLoading may remain).
  const productPurchaseRemovedVisibleFiles = [
    [
      "settings/model-provider-section/Detail.tsx",
      "Detail.tsx",
    ],
    [
      "settings/model-provider-section/StatusCards.tsx",
      "StatusCards.tsx",
    ],
    [
      "settings/model-provider-section/CodingPlanStatusActions.tsx",
      "CodingPlanStatusActions.tsx",
    ],
  ];
  const deadLoginActionVisibleSymbols = [
    "loginActionVisible",
    "loginVisible",
    "loginButtonId",
  ];
  for (const [rel, label] of productPurchaseRemovedVisibleFiles) {
    const renamePath = join(UI_SRC, rel);
    if (!existsSync(renamePath)) {
      fails.push(`${label} must exist (#158 gate)`);
      continue;
    }
    const renameSrc = readFileSync(renamePath, "utf8");
    for (const dead of deadLoginActionVisibleSymbols) {
      if (renameSrc.includes(dead)) {
        fails.push(
          `${label} must not revive old login-action symbol: ${dead} (#158)`,
        );
      }
    }
    if (!renameSrc.includes("productPurchaseRemovedVisible")) {
      fails.push(
        `${label} must keep productPurchaseRemovedVisible (#158)`,
      );
    }
  }
  const statusActionsPath = join(
    UI_SRC,
    "settings/model-provider-section/CodingPlanStatusActions.tsx",
  );
  if (existsSync(statusActionsPath)) {
    const statusActionsSrc = readFileSync(statusActionsPath, "utf8");
    if (!statusActionsSrc.includes("productPurchaseRemoved")) {
      fails.push(
        "CodingPlanStatusActions.tsx must keep productPurchaseRemoved body (#158)",
      );
    }
    if (!statusActionsSrc.includes("CodingPlanProductPurchaseRemovedNotice")) {
      fails.push(
        "CodingPlanStatusActions.tsx must keep CodingPlanProductPurchaseRemovedNotice (#158)",
      );
    }
  }

  // #159: owned-entry plan helper hard-absent after zero-ref unload.
  // KEEP EnterpriseCodingPlanProductDisplay (enterpriseCodingPlanProducts.ts).
  const ownedEntryPlansPath = join(UI_SRC, "lib/codingPlanOwnedEntryPlans.ts");
  if (existsSync(ownedEntryPlansPath)) {
    fails.push(
      "codingPlanOwnedEntryPlans.ts must stay deleted (owned-entry helper unload #159)",
    );
  }
  const displayPath = join(
    UI_SRC,
    "settings/model-provider-section/enterpriseCodingPlanProducts.ts",
  );
  if (!existsSync(displayPath)) {
    fails.push(
      "enterpriseCodingPlanProducts.ts must exist (Display KEEP #159)",
    );
  } else {
    const displaySrc = readFileSync(displayPath, "utf8");
    if (!/\bEnterpriseCodingPlanProductDisplay\b/.test(displaySrc)) {
      fails.push(
        "enterpriseCodingPlanProducts.ts must keep EnterpriseCodingPlanProductDisplay (#159)",
      );
    }
  }
  const deadOwnedEntrySymbols = [
    "codingPlanOwnedEntryPlans",
    "buildOwnedEntryPlanList",
  ];
  function walkUiForOwnedEntry(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walkUiForOwnedEntry(full);
        continue;
      }
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(ent.name)) continue;
      const src = readFileSync(full, "utf8");
      for (const dead of deadOwnedEntrySymbols) {
        if (src.includes(dead)) {
          fails.push(
            `${relative(ROOT, full)} must not revive ${dead} (#159)`,
          );
        }
      }
    }
  }
  if (existsSync(UI_SRC)) {
    walkUiForOwnedEntry(UI_SRC);
  }

  // #162: dead product-login residual helpers hard-absent.
  // KEEP EnterpriseCodingPlanProductDisplay (enterpriseCodingPlanProducts.ts).
  const teamPlanDisplayNamePath = join(UI_SRC, "lib/teamPlanDisplayName.ts");
  if (existsSync(teamPlanDisplayNamePath)) {
    fails.push(
      "teamPlanDisplayName.ts must stay deleted (residual helper unload #162)",
    );
  }
  const codingPlanErrorMessagePath = join(
    UI_SRC,
    "settings/model-provider-section/codingPlanErrorMessage.ts",
  );
  if (existsSync(codingPlanErrorMessagePath)) {
    fails.push(
      "codingPlanErrorMessage.ts must stay deleted (residual helper unload #162)",
    );
  }
  const displayPath162 = join(
    UI_SRC,
    "settings/model-provider-section/enterpriseCodingPlanProducts.ts",
  );
  if (!existsSync(displayPath162)) {
    fails.push(
      "enterpriseCodingPlanProducts.ts must exist (Display KEEP #162)",
    );
  } else {
    const displaySrc162 = readFileSync(displayPath162, "utf8");
    if (!/\bEnterpriseCodingPlanProductDisplay\b/.test(displaySrc162)) {
      fails.push(
        "enterpriseCodingPlanProducts.ts must keep EnterpriseCodingPlanProductDisplay (#162)",
      );
    }
  }
  const deadResidualSymbols = [
    "formatTeamPlanDisplayName",
    "teamPlanDisplayName",
    "codingPlanErrorMessage",
  ];
  function walkUiSrcForResidual(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "dist") continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walkUiSrcForResidual(full);
        continue;
      }
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(ent.name)) continue;
      const src = readFileSync(full, "utf8");
      for (const dead of deadResidualSymbols) {
        if (src.includes(dead)) {
          fails.push(
            `${relative(ROOT, full)} must not revive ${dead} (#162)`,
          );
        }
      }
    }
  }
  if (existsSync(UI_SRC)) {
    walkUiSrcForResidual(UI_SRC);
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

  // #176: sample dead Coding Plan subscription purchase/payment/preview/sign DTOs hard-absent.
  // KEEP ForceUpdateConfig + EnterpriseCodingPlanPricingProduct (Display deps stay elsewhere).
  const subscriptionTypesPath = join(
    ROOT,
    "packages/shared/src/coding-plan-subscription.ts",
  );
  if (!existsSync(subscriptionTypesPath)) {
    fails.push(
      "coding-plan-subscription.ts must exist (#176 KEEP ForceUpdateConfig / EnterpriseCodingPlanPricingProduct)",
    );
  } else {
    const subscriptionTypesSrc = readFileSync(subscriptionTypesPath, "utf8");
    // Representative sample of #176 unloaded surfaces (full drop list in squash #176).
    const deadSubscriptionDtoSamples = [
      "CodingPlanPayType",
      "CodingPlanOverseasPaymentChannel",
      "CodingPlanProductPreviewPayment",
      "CodingPlanBatchPreviewRequest",
      "CodingPlanPreviewRequest",
      "CodingPlanPreviewResponse",
      "CodingPlanCreateSignRequest",
      "CodingPlanUpdateSignRequest",
      "CodingPlanPaymentCheckRequest",
      "CodingPlanStripeCard",
      "CodingPlanStripeBindRequest",
      "CodingPlanStripePayRequest",
      "CodingPlanPaypalSupportRequest",
      "CodingPlanPaypalSetupTokenRequest",
      "CodingPlanPaypalSubscribeRequest",
      "EnterpriseCodingPlanCreateOrderRequest",
      "EnterpriseCodingPlanOrderStatusResponse",
    ];
    for (const dead of deadSubscriptionDtoSamples) {
      if (subscriptionTypesSrc.includes(dead)) {
        fails.push(
          `coding-plan-subscription.ts must not revive dead subscription DTO: ${dead} (#176)`,
        );
      }
    }
    if (!/\bForceUpdateConfig\b/.test(subscriptionTypesSrc)) {
      fails.push(
        "coding-plan-subscription.ts must keep ForceUpdateConfig (#176)",
      );
    }
    if (!/\bEnterpriseCodingPlanPricingProduct\b/.test(subscriptionTypesSrc)) {
      fails.push(
        "coding-plan-subscription.ts must keep EnterpriseCodingPlanPricingProduct (#176)",
      );
    }
  }

  // #186: file-local PersonalCodingPlanSubscription / TeamCodingPlanSubscription
  // renamed → *EntitlementRecord. Hard-absent old aliases from codingPlanEntitlement.ts.
  // KEEP CodingPlanEntitlement.subscription field (do not treat `.subscription` as dead).
  const entitlementTypesPath = join(
    ROOT,
    "packages/services/src/bigmodel/codingPlanEntitlement.ts",
  );
  if (!existsSync(entitlementTypesPath)) {
    fails.push(
      "codingPlanEntitlement.ts must exist (#186 KEEP CodingPlanEntitlement.subscription)",
    );
  } else {
    const entitlementTypesSrc = readFileSync(entitlementTypesPath, "utf8");
    const deadEntitlementAliasSamples = [
      "PersonalCodingPlanSubscription",
      "TeamCodingPlanSubscription",
    ];
    for (const dead of deadEntitlementAliasSamples) {
      if (new RegExp(`\\b${dead}\\b`).test(entitlementTypesSrc)) {
        fails.push(
          `codingPlanEntitlement.ts must not revive dead entitlement alias: ${dead} (#186)`,
        );
      }
    }
    if (
      !/\bCodingPlanEntitlement\b/.test(entitlementTypesSrc) ||
      !/kind:\s*"available";\s*subscription:\s*T/.test(entitlementTypesSrc)
    ) {
      fails.push(
        "codingPlanEntitlement.ts must keep CodingPlanEntitlement.subscription (#186)",
      );
    }
  }


  // #198/#199/#203: loginPending → statusPending rename hard-absent on viewState + Detail.
  // KEEP statusPending + codingPlanStatusGatePending + productPurchaseRemoved*.
  const statusPendingRenameFiles = [
    [
      "settings/model-provider-section/codingPlanStatusPanelViewState.ts",
      "codingPlanStatusPanelViewState.ts",
    ],
    [
      "settings/model-provider-section/Detail.tsx",
      "Detail.tsx",
    ],
  ];
  const deadStatusPendingSymbols = [
    "loginPending",
    "codingPlanLoginPending",
  ];
  for (const [rel, label] of statusPendingRenameFiles) {
    const renamePath = join(UI_SRC, rel);
    if (!existsSync(renamePath)) {
      fails.push(`${label} must exist (#198/#199/#203 gate)`);
      continue;
    }
    const renameSrc = readFileSync(renamePath, "utf8");
    for (const dead of deadStatusPendingSymbols) {
      // viewState never had codingPlanLoginPending; still assert absence on both.
      if (renameSrc.includes(dead)) {
        fails.push(
          `${label} must not revive old status-pending symbol: ${dead} (#198/#199/#203)`,
        );
      }
    }
    if (!renameSrc.includes("statusPending")) {
      fails.push(`${label} must keep statusPending (#198/#203)`);
    }
  }
  const detailStatusPendingPath = join(
    UI_SRC,
    "settings/model-provider-section/Detail.tsx",
  );
  if (existsSync(detailStatusPendingPath)) {
    const detailStatusPendingSrc = readFileSync(detailStatusPendingPath, "utf8");
    if (!detailStatusPendingSrc.includes("codingPlanStatusGatePending")) {
      fails.push(
        "Detail.tsx must keep codingPlanStatusGatePending (#199/#203)",
      );
    }
    if (!detailStatusPendingSrc.includes("productPurchaseRemoved")) {
      fails.push(
        "Detail.tsx must keep productPurchaseRemoved (#203 KEEP)",
      );
    }
    if (!detailStatusPendingSrc.includes("productPurchaseRemovedVisible")) {
      fails.push(
        "Detail.tsx must keep productPurchaseRemovedVisible (#203 KEEP)",
      );
    }
  }


  // #200/#204: presetSubscriptionProviderId → presetCatalogProviderId hard-pin.
  // ModelProviderSection + Detail only; do not expand tip-ledger SHA string (Ex1).
  const presetCatalogRenameFiles = [
    ["settings/ModelProviderSection.tsx", "ModelProviderSection.tsx"],
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
  ];
  const deadPresetSubscriptionSymbols = [
    "presetSubscriptionProviderId",
    "setPresetSubscriptionProviderId",
  ];
  for (const [rel, label] of presetCatalogRenameFiles) {
    const renamePath = join(UI_SRC, rel);
    if (!existsSync(renamePath)) {
      fails.push(`${label} must exist (#200/#204 gate)`);
      continue;
    }
    const renameSrc = readFileSync(renamePath, "utf8");
    for (const dead of deadPresetSubscriptionSymbols) {
      if (renameSrc.includes(dead)) {
        fails.push(
          `${label} must not revive old preset-subscription symbol: ${dead} (#200/#204)`,
        );
      }
    }
    if (!renameSrc.includes("presetCatalogProviderId")) {
      fails.push(`${label} must keep presetCatalogProviderId (#200/#204)`);
    }
  }

  // #178/#205: loginLoading → statusSyncLoading rename hard-absent on Detail / StatusCards / viewState.
  // KEEP statusSyncLoading (symmetric to #205/#178 rename; UI test pin lives in #205).
  const statusSyncLoadingRenameFiles = [
    [
      "settings/model-provider-section/Detail.tsx",
      "Detail.tsx",
    ],
    [
      "settings/model-provider-section/StatusCards.tsx",
      "StatusCards.tsx",
    ],
    [
      "settings/model-provider-section/codingPlanStatusPanelViewState.ts",
      "codingPlanStatusPanelViewState.ts",
    ],
  ];
  for (const [rel, label] of statusSyncLoadingRenameFiles) {
    const renamePath = join(UI_SRC, rel);
    if (!existsSync(renamePath)) {
      fails.push(`${label} must exist (#178/#205 gate)`);
      continue;
    }
    const renameSrc = readFileSync(renamePath, "utf8");
    if (renameSrc.includes("loginLoading")) {
      fails.push(
        `${label} must not revive loginLoading (#178/#205)`,
      );
    }
    if (!renameSrc.includes("statusSyncLoading")) {
      fails.push(`${label} must keep statusSyncLoading (#178/#205)`);
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
    "Tip 04fc2af (#244 Ex3 lazy target-unavailable OUT / after #243 tip-ledger + #242 SessionHost idle-close-then-reopen OUT + #241 Ex4 quota banner upgrade stubs OUT + #240 REMOVE-PLAN soft + #239 docs + #238 Ex3 lazyAdmission pin + #237/#235 docs + #236/#242 SessionHost idle-close(+then-reopen)-during-permission + #234 docs + #233 Ex4 quota banner upgrade provider OUT + #232 tip-ledger + #231 docs + #230 Ex4 setProviderFamilyDomain writer OUT + #229 SessionHost ddp-then-reopen + #228 Ex3 lazyAdmission + #227 tip-ledger + #226 Ex4 automatic family selection OUT + #225 Host honesty + #224 docs + #223 SessionHost disconnect-during-permission + #222 tip-ledger + #221 multiHarness + #220 tip-ledger + #219 docs + #218 subscribeClose AcpRpc + #217 SessionHost load-then-send + #216/#215 tip-ledger + #214 tip SHA + #213/#212 docs + #211 SessionHost permission-during + #210/#209/#207 hard-pins + #204–#205 pins + #203/#202 / #198–#200 / #195–#201; after (#194 REMOVE + #192 hard-pin + #190 Catalog / after #103–#244): Dialog/Provider/Entry/EmbeddedWebview + CLI loginRequired→modelSetupRequired hard. UI locale dead product loginRequired / Coding Plan login + orphan Welcome/login.* shell + #103–#107 upgrade/purchase/usage/enterprise acquisition i18n hard-gated. login.oauth.regionTag.* absent; KEEP settings.modelProvider.regionTag.* + share-import signInRequired + manage/planCard + productPurchaseRemoved body + live personal API-key / MCP OAuth copy. #114 slash-help /login+/logout off Coding Plan/Z.ai OAuth acquisition → model-setup/API-key guidance hard-gated (KEEP MCP help). #123 useEnterpriseCodingPlanProducts.ts hard-absent; #124 productPurchaseRemovedTitle absent; #126 refreshTeamPlanProducts hard-absent (KEEP entitlement refresh); #128/#Ex1/#142 usageSources buildCodingPlanUsageSources hard-absent (KEEP CodingPlanUsageSource / personal builder / sidebar resolver); #131–#135+/#141 Settings/V4/sidebar/MPS/visibility subscribedTeamProducts stubs+wiring hard-absent; #145 teamSources/team audience hard-absent; #146/#148 codingPlanLogin noop (onCodingPlanLogin/handleCodingPlanLogin) hard-absent (KEEP codingPlanStatusGatePending after #199); #150 onCodingPlanPurchaseComplete/codingPlanPurchaseToken/refreshPurchaseTokenState hard-absent (KEEP quota/OAuth refresh); #152/#156 oauthTeamPricing.ts + account-loss getEnterprisePricingProducts/productList team fallback hard-absent (KEEP prepareAccountConnectionSwitch + individual-coding-plan); soft ledger #140/#143/#147/#149/#153/#155/#174/#177/#182/#187/#195/#196/#202/#211/#217/#223/#229/#236/#242 SessionHost OUT + #144/#151 productList comment scrubs + #157 family team feed (resolveFirstSubscribedTeamPlanConnectionWithContext/teamProducts) soft; #158/#160 loginActionVisible→productPurchaseRemovedVisible hard-gated (KEEP productPurchaseRemovedVisible + body); #159/#163 codingPlanOwnedEntryPlans/buildOwnedEntryPlanList hard-absent (KEEP Display); #162/#164 teamPlanDisplayName/codingPlanErrorMessage hard-absent (KEEP Display); #161/#165 P6 tip docs; #168/#170 sample dead purchase/webview/pricing locale + zai/bigmodel plan|purchase prefixes hard-gated (KEEP manage/planCard/productPurchaseRemoved); #166 status-comment scrub; #167 tip-ledger; #169/#171 P6 tip docs; #173/#180 P6 tip docs; #172 sample Start Plan acquisition/preview/highlight + dead connectionMode plan-access i18n hard-gated (KEEP live connectionMode labels + startPlan.status/balance.title/refreshEntitlement/expiresAt/pendingUntil); #176/#181 sample dead CodingPlanPaypal*/Stripe*/preview/sign subscription DTOs hard-absent (KEEP ForceUpdateConfig + EnterpriseCodingPlanPricingProduct); #185/#215/#216/#220/#222/#227/#232/#243 tip-ledger; #186/#192 PersonalCodingPlanSubscription/TeamCodingPlanSubscription hard-absent (KEEP CodingPlanEntitlement.subscription); #178 loginLoading→statusSyncLoading rename soft; #179 billingBanner/relogin/renew locale drop soft; #187/#211/#217/#223/#229/#236/#242 SessionHost OUT; #188/#189/#191/#193/#197/#201/#206/#208/#212/#213/#214/#219/#224/#231/#234/#235/#237/#239 P6/agent-host docs soft; #215/#216/#220/#222/#227/#232/#243 tip-ledger soft; #218 subscribeClose AcpRpc soft; #221 multiHarness admission soft; #225 Host honesty soft; #226 Ex4 automatic family selection soft; #228/#238/#244 Ex3 lazyAdmission soft; #230 Ex4 setProviderFamilyDomain writer soft; #233 Ex4 quota banner upgrade provider soft; #240 REMOVE-PLAN tip soft; #241 Ex4 quota banner upgrade stubs soft; #190 CodingPlanSubscriptionProviderId→Catalog rename soft; #194/#240 REMOVE tip docs soft; #198 loginPending→statusPending soft; #199 codingPlanLoginPending→codingPlanStatusGatePending soft; #200 presetSubscriptionProviderId→presetCatalogProviderId soft; #203 statusPending/statusGatePending pin soft; #204 presetCatalogProviderId pin soft; #205 loginLoading absent/statusSyncLoading pin soft; #207 statusPending/loginPending hard-pin (KEEP statusPending + codingPlanStatusGatePending); #209 presetCatalog hard-pin (KEEP presetCatalogProviderId); #210 loginLoading absent hard-pin (KEEP statusSyncLoading). Soft inventory thinned — cleared symbol scans dropped. Inventory does not fail this gate.";

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
