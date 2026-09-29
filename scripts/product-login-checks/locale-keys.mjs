import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, UI_SRC, grepFiles } from "./source-utils.mjs";

export function checkLocaleKeys() {
  const fails = [];
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
  return fails;
}
