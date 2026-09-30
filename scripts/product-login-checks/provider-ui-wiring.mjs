import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_SRC } from "./source-utils.mjs";

export function checkProviderUiWiring() {
  const fails = [];
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
      fails.push("modelProviderActions.ts must not retain refreshTeamPlanProducts (#126)");
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
      fails.push("ModelProviderSection.tsx must not wire refreshTeamPlanProducts (#126)");
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
      fails.push("codingPlanUsageSources must keep resolveSidebarCurrentCodingPlanUsageSource");
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
      fails.push("codingPlanUsageSources must not revive teamSources param (#145)");
    }
    if (/audience:\s*"team"/.test(usageSrc)) {
      fails.push("codingPlanUsageSources must not revive team audience sidebar branch (#145)");
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
      fails.push(`${label} must not keep subscribedTeamProducts call-site / signature wiring`);
    }
  }

  // #146/#148: codingPlanLogin noop prop chain hard-absent after StatusCards gate drop.
  // KEEP codingPlanLoginPending (status-sync flag; not the noop prop).
  const codingPlanLoginFiles = [
    ["settings/ModelProviderSection.tsx", "ModelProviderSection.tsx"],
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
    ["settings/model-provider-section/StatusCards.tsx", "StatusCards.tsx"],
  ];
  const deadCodingPlanLoginSymbols = ["onCodingPlanLogin", "handleCodingPlanLogin"];
  for (const [rel, label] of codingPlanLoginFiles) {
    const loginPath = join(UI_SRC, rel);
    if (!existsSync(loginPath)) {
      fails.push(`${label} must exist (#146/#148 gate)`);
      continue;
    }
    const loginSrc = readFileSync(loginPath, "utf8");
    for (const dead of deadCodingPlanLoginSymbols) {
      if (loginSrc.includes(dead)) {
        fails.push(`${label} must not revive codingPlanLogin noop symbol: ${dead} (#146/#148)`);
      }
    }
  }

  // #150: purchase-complete / purchase-token wiring hard-absent.
  // KEEP onQuotaResetEntitlementRefresh / refreshActiveOAuthProvider*.
  const purchaseCompleteFiles = [
    ["settings/ModelProviderSection.tsx", "ModelProviderSection.tsx"],
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
    ["settings/model-provider-section/modelProviderActions.ts", "modelProviderActions.ts"],
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
        fails.push(`${label} must not revive purchase-complete symbol: ${dead} (#150)`);
      }
    }
  }

  // #152: oauthTeamPricing empty productList + account-loss team fallback hard-absent.
  // KEEP prepareAccountConnectionSwitch + individual-coding-plan; Display/entitlement KEPT elsewhere.
  const oauthTeamPricingPath = join(UI_SRC, "root/oauthTeamPricing.ts");
  if (existsSync(oauthTeamPricingPath)) {
    fails.push("oauthTeamPricing.ts must stay deleted (empty team pricing fallback unload #152)");
  }
  const accountLossSuggestionPath = join(UI_SRC, "root/accountConnectionLossSuggestion.ts");
  if (!existsSync(accountLossSuggestionPath)) {
    fails.push("accountConnectionLossSuggestion.ts must exist (#152 KEEP)");
  } else {
    const suggestionSrc = readFileSync(accountLossSuggestionPath, "utf8");
    for (const dead of ["oauthTeamPricing", "getEnterprisePricingProducts", "productList"]) {
      if (suggestionSrc.includes(dead)) {
        fails.push(`accountConnectionLossSuggestion.ts must not revive ${dead} (#152)`);
      }
    }
    if (!/\bprepareAccountConnectionSwitch\b/.test(suggestionSrc)) {
      fails.push(
        "accountConnectionLossSuggestion.ts must keep prepareAccountConnectionSwitch (#152)",
      );
    }
    if (!/\bindividual-coding-plan\b/.test(suggestionSrc)) {
      fails.push("accountConnectionLossSuggestion.ts must keep individual-coding-plan path (#152)");
    }
  }

  // #158: loginActionVisible rename — old prop names hard-absent.
  // KEEP productPurchaseRemovedVisible + productPurchaseRemoved body (statusSyncLoading may remain).
  const productPurchaseRemovedVisibleFiles = [
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
    ["settings/model-provider-section/StatusCards.tsx", "StatusCards.tsx"],
    ["settings/model-provider-section/CodingPlanStatusActions.tsx", "CodingPlanStatusActions.tsx"],
  ];
  const deadLoginActionVisibleSymbols = ["loginActionVisible", "loginVisible", "loginButtonId"];
  for (const [rel, label] of productPurchaseRemovedVisibleFiles) {
    const renamePath = join(UI_SRC, rel);
    if (!existsSync(renamePath)) {
      fails.push(`${label} must exist (#158 gate)`);
      continue;
    }
    const renameSrc = readFileSync(renamePath, "utf8");
    for (const dead of deadLoginActionVisibleSymbols) {
      if (renameSrc.includes(dead)) {
        fails.push(`${label} must not revive old login-action symbol: ${dead} (#158)`);
      }
    }
    if (!renameSrc.includes("productPurchaseRemovedVisible")) {
      fails.push(`${label} must keep productPurchaseRemovedVisible (#158)`);
    }
  }
  const statusActionsPath = join(
    UI_SRC,
    "settings/model-provider-section/CodingPlanStatusActions.tsx",
  );
  if (existsSync(statusActionsPath)) {
    const statusActionsSrc = readFileSync(statusActionsPath, "utf8");
    if (!statusActionsSrc.includes("productPurchaseRemoved")) {
      fails.push("CodingPlanStatusActions.tsx must keep productPurchaseRemoved body (#158)");
    }
    if (!statusActionsSrc.includes("CodingPlanProductPurchaseRemovedNotice")) {
      fails.push(
        "CodingPlanStatusActions.tsx must keep CodingPlanProductPurchaseRemovedNotice (#158)",
      );
    }
  }

  return fails;
}
