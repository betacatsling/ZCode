/**
 * Soft pin: loginLoading → statusSyncLoading (#178).
 * Separate from Ex3 codingPlanStatusPendingRename.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const detail = readUi("../src/settings/model-provider-section/Detail.tsx");
const statusCards = readUi("../src/settings/model-provider-section/StatusCards.tsx");
const viewState = readUi(
  "../src/settings/model-provider-section/codingPlanStatusPanelViewState.ts",
);

const surfaces: readonly { label: string; src: string }[] = [
  { label: "Detail", src: detail },
  { label: "StatusCards", src: statusCards },
  { label: "codingPlanStatusPanelViewState", src: viewState },
];

test("status panel surfaces dropped loginLoading", () => {
  for (const { label, src } of surfaces) {
    assert.equal(src.includes("loginLoading"), false, `${label} must not keep loginLoading`);
  }
});

test("status panel surfaces use statusSyncLoading", () => {
  for (const { label, src } of surfaces) {
    assert.equal(src.includes("statusSyncLoading"), true, `${label} must use statusSyncLoading`);
  }
});
