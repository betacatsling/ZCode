import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, UI_SRC } from "./source-utils.mjs";

export function checkLegacyHelpers() {
  const fails = [];
  // #159: owned-entry plan helper hard-absent after zero-ref unload.
  // KEEP EnterpriseCodingPlanProductDisplay (enterpriseCodingPlanProducts.ts).
  const ownedEntryPlansPath = join(UI_SRC, "lib/codingPlanOwnedEntryPlans.ts");
  if (existsSync(ownedEntryPlansPath)) {
    fails.push("codingPlanOwnedEntryPlans.ts must stay deleted (owned-entry helper unload #159)");
  }
  const displayPath = join(
    UI_SRC,
    "settings/model-provider-section/enterpriseCodingPlanProducts.ts",
  );
  if (!existsSync(displayPath)) {
    fails.push("enterpriseCodingPlanProducts.ts must exist (Display KEEP #159)");
  } else {
    const displaySrc = readFileSync(displayPath, "utf8");
    if (!/\bEnterpriseCodingPlanProductDisplay\b/.test(displaySrc)) {
      fails.push(
        "enterpriseCodingPlanProducts.ts must keep EnterpriseCodingPlanProductDisplay (#159)",
      );
    }
  }
  const deadOwnedEntrySymbols = ["codingPlanOwnedEntryPlans", "buildOwnedEntryPlanList"];
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
          fails.push(`${relative(ROOT, full)} must not revive ${dead} (#159)`);
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
    fails.push("teamPlanDisplayName.ts must stay deleted (residual helper unload #162)");
  }
  const codingPlanErrorMessagePath = join(
    UI_SRC,
    "settings/model-provider-section/codingPlanErrorMessage.ts",
  );
  if (existsSync(codingPlanErrorMessagePath)) {
    fails.push("codingPlanErrorMessage.ts must stay deleted (residual helper unload #162)");
  }
  const displayPath162 = join(
    UI_SRC,
    "settings/model-provider-section/enterpriseCodingPlanProducts.ts",
  );
  if (!existsSync(displayPath162)) {
    fails.push("enterpriseCodingPlanProducts.ts must exist (Display KEEP #162)");
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
          fails.push(`${relative(ROOT, full)} must not revive ${dead} (#162)`);
        }
      }
    }
  }
  if (existsSync(UI_SRC)) {
    walkUiSrcForResidual(UI_SRC);
  }

  return fails;
}
