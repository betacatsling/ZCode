import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const viewState = readUi(
  "../src/settings/model-provider-section/codingPlanStatusPanelViewState.ts",
);
const detail = readUi("../src/settings/model-provider-section/Detail.tsx");

/**
 * Pin #198/#199: coding-plan status-panel view-state input + Detail call-site
 * use `statusPending` (not `loginPending`). Detail-local boolean is
 * `codingPlanStatusGatePending` (not `codingPlanLoginPending` after #199).
 * KEEP `productPurchaseRemoved*`, and entitlement wiring.
 */
test("codingPlanStatusPanelViewState uses statusPending and drops loginPending", () => {
  assert.equal(viewState.includes("loginPending"), false);
  assert.equal(viewState.includes("statusPending"), true);
  assert.match(viewState, /\bstatusPending\s*:/);
  assert.match(viewState, /\bstatusPending\b/);
});

test("Detail wires statusPending (not loginPending) into resolveCodingPlanStatusPanelViewState", () => {
  assert.equal(detail.includes("loginPending"), false);
  assert.equal(detail.includes("statusPending"), true);
  assert.match(
    detail,
    /resolveCodingPlanStatusPanelViewState\(\{[\s\S]*?statusPending\s*:/,
  );
});

test("Detail uses codingPlanStatusGatePending; keeps productPurchaseRemoved and entitlement", () => {
  assert.equal(detail.includes("codingPlanLoginPending"), false);
  assert.equal(detail.includes("codingPlanStatusGatePending"), true);
  assert.match(detail, /\bcodingPlanStatusGatePending\b/);
  assert.equal(detail.includes("productPurchaseRemoved"), true);
  assert.equal(detail.includes("productPurchaseRemovedVisible"), true);
  assert.equal(detail.includes("hasResolvedEntitlementStatus"), true);
  assert.match(detail, /\bentitlement\b/);
});
