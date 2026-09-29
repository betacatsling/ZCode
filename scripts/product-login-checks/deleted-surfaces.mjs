import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, CHANNELS, PLATFORM, UI_SRC, grepFiles } from "./source-utils.mjs";

export function checkDeletedSurfaces() {
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
    fails.push("CodingPlanUpgradeDialogProvider.tsx must stay deleted (Dialog unload on tip)");
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
  const purchaseAuth = join(UI_SRC, "settings/model-provider-section/codingPlanPurchaseAuth.ts");
  if (existsSync(purchaseAuth)) {
    fails.push("codingPlanPurchaseAuth.ts must stay deleted (purchase auth stub unload)");
  }
  const pricingCards = join(UI_SRC, "settings/model-provider-section/codingPlanPricingCards.ts");
  if (existsSync(pricingCards)) {
    fails.push("codingPlanPricingCards.ts must stay deleted (CodingPlanLoginOptions unload)");
  }
  // #123: orphan enterprise products hook must stay deleted (Display/entitlement KEPT).
  const enterpriseProductsHook = join(
    UI_SRC,
    "settings/model-provider-section/useEnterpriseCodingPlanProducts.ts",
  );
  if (existsSync(enterpriseProductsHook)) {
    fails.push("useEnterpriseCodingPlanProducts.ts must stay deleted (orphan hook unload #123)");
  }
  const detailPath = join(UI_SRC, "settings/model-provider-section/Detail.tsx");
  if (existsSync(detailPath)) {
    const detailSrc = readFileSync(detailPath, "utf8");
    if (
      /CodingPlanPurchaseChoiceBanners|purchaseChoiceBannersVisible|CodingPlanAccessBanner/.test(
        detailSrc,
      )
    ) {
      fails.push("Detail.tsx must not retain Coding Plan purchase/access banners");
    }
  }
  const codingPlanWebviewPreload = join(ROOT, "packages/desktop/src/preload/codingPlanWebview.ts");
  if (existsSync(codingPlanWebviewPreload)) {
    fails.push(
      "codingPlanWebview.ts preload must stay deleted (Coding Plan embedded webview unload)",
    );
  }
  const desktopChromePath = join(ROOT, "packages/desktop/src/main/desktopWindowChrome.ts");
  if (existsSync(desktopChromePath)) {
    const chromeSrc = readFileSync(desktopChromePath, "utf8");
    if (
      /isCodingPlanEmbeddedWebviewSrc|codingPlanWebviewPreloadPath|isCodingPlanPaypalNavigationUrl/.test(
        chromeSrc,
      )
    ) {
      fails.push(
        "desktopWindowChrome.ts must not retain Coding Plan embedded/PayPal special cases",
      );
    }
  }
  const desktopHandlersPath = join(ROOT, "packages/desktop/src/main/desktopCommandHandlers.ts");
  if (existsSync(desktopHandlersPath)) {
    const handlersSrc = readFileSync(desktopHandlersPath, "utf8");
    if (
      /clearCodingPlanWebviewStorage|CODING_PLAN_WEBVIEW_PARTITION|persist:zcode-coding-plan/.test(
        handlersSrc,
      )
    ) {
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

  return fails;
}
