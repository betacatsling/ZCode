import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./source-utils.mjs";

export function checkSharedContracts() {
  const fails = [];
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
        fails.push(`slash-help must keep model-setup / API-key guidance snippet: ${snippet}`);
      }
    }
    // KEEP MCP help entry (unchanged by #114).
    if (!/name:\s*"mcp"/.test(slashHelpSrc) || !/\bMCP\b/.test(slashHelpSrc)) {
      fails.push("slash-help must keep MCP command help entry");
    }
  }

  // #176: sample dead Coding Plan subscription purchase/payment/preview/sign DTOs hard-absent.
  // KEEP ForceUpdateConfig + EnterpriseCodingPlanPricingProduct (Display deps stay elsewhere).
  const subscriptionTypesPath = join(ROOT, "packages/shared/src/coding-plan-subscription.ts");
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
      fails.push("coding-plan-subscription.ts must keep ForceUpdateConfig (#176)");
    }
    if (!/\bEnterpriseCodingPlanPricingProduct\b/.test(subscriptionTypesSrc)) {
      fails.push("coding-plan-subscription.ts must keep EnterpriseCodingPlanPricingProduct (#176)");
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
      fails.push("codingPlanEntitlement.ts must keep CodingPlanEntitlement.subscription (#186)");
    }
  }

  return fails;
}
