import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const detail = readUi("../src/settings/model-provider-section/Detail.tsx");
const section = readUi("../src/settings/ModelProviderSection.tsx");

test("settings model-provider Detail does not open Coding Plan upgrade", () => {
  assert.equal(detail.includes("useCodingPlanUpgradeDialog"), false);
  assert.equal(detail.includes("openCodingPlanUpgrade"), false);
  assert.match(detail, /upgradeActionVisible=\{false\}/);
});

test("settings ModelProviderSection login stub does not open Coding Plan upgrade", () => {
  assert.equal(section.includes("useOptionalCodingPlanUpgradeDialog"), false);
  assert.equal(section.includes("useCodingPlanUpgradeDialog"), false);
  assert.equal(section.includes("openCodingPlanUpgrade"), false);
  assert.match(
    section,
    /\[ModelProviderSection\] 产品登录已下线，不再连接 Coding Plan/,
  );
});
