import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_SRC } from "./source-utils.mjs";

export function checkStatusFields() {
  const fails = [];
  // #198/#199/#203: loginPending → statusPending rename hard-absent on viewState + Detail.
  // KEEP statusPending + codingPlanStatusGatePending + productPurchaseRemoved*.
  const statusPendingRenameFiles = [
    [
      "settings/model-provider-section/codingPlanStatusPanelViewState.ts",
      "codingPlanStatusPanelViewState.ts",
    ],
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
  ];
  const deadStatusPendingSymbols = ["loginPending", "codingPlanLoginPending"];
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
        fails.push(`${label} must not revive old status-pending symbol: ${dead} (#198/#199/#203)`);
      }
    }
    if (!renameSrc.includes("statusPending")) {
      fails.push(`${label} must keep statusPending (#198/#203)`);
    }
  }
  const detailStatusPendingPath = join(UI_SRC, "settings/model-provider-section/Detail.tsx");
  if (existsSync(detailStatusPendingPath)) {
    const detailStatusPendingSrc = readFileSync(detailStatusPendingPath, "utf8");
    if (!detailStatusPendingSrc.includes("codingPlanStatusGatePending")) {
      fails.push("Detail.tsx must keep codingPlanStatusGatePending (#199/#203)");
    }
    if (!detailStatusPendingSrc.includes("productPurchaseRemoved")) {
      fails.push("Detail.tsx must keep productPurchaseRemoved (#203 KEEP)");
    }
    if (!detailStatusPendingSrc.includes("productPurchaseRemovedVisible")) {
      fails.push("Detail.tsx must keep productPurchaseRemovedVisible (#203 KEEP)");
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
        fails.push(`${label} must not revive old preset-subscription symbol: ${dead} (#200/#204)`);
      }
    }
    if (!renameSrc.includes("presetCatalogProviderId")) {
      fails.push(`${label} must keep presetCatalogProviderId (#200/#204)`);
    }
  }

  // #178/#205: loginLoading → statusSyncLoading rename hard-absent on Detail / StatusCards / viewState.
  // KEEP statusSyncLoading (symmetric to #205/#178 rename; UI test pin lives in #205).
  const statusSyncLoadingRenameFiles = [
    ["settings/model-provider-section/Detail.tsx", "Detail.tsx"],
    ["settings/model-provider-section/StatusCards.tsx", "StatusCards.tsx"],
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
      fails.push(`${label} must not revive loginLoading (#178/#205)`);
    }
    if (!renameSrc.includes("statusSyncLoading")) {
      fails.push(`${label} must keep statusSyncLoading (#178/#205)`);
    }
  }

  return fails;
}
