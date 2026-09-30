import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("modelProviderActions drops refreshTeamPlanProducts after enterprise products removal", () => {
  const actions = readUi("../src/settings/model-provider-section/modelProviderActions.ts");
  assert.equal(actions.includes("refreshTeamPlanProducts"), false);
  assert.match(actions, /export async function refreshModelProviderSection/);
  assert.match(actions, /export async function refreshProviderPanelAfterAuthChange/);
  assert.match(actions, /refreshCodingPlanEntitlements/);
});

test("ModelProviderSection no longer wires enterprise products refresh noop", () => {
  const section = readUi("../src/settings/ModelProviderSection.tsx");
  assert.equal(section.includes("refreshTeamPlanProducts"), false);
  assert.equal(section.includes("refreshAuthenticatedEnterpriseProducts"), false);
  assert.equal(section.includes("subscribedTeamProducts"), false);
  assert.match(section, /refreshCodingPlanEntitlements/);
});
