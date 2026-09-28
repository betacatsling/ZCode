/**
 * Soft pin: teamPlan ensure/copy/biz-headers dead after product OAuth unload (Ex4).
 * KEEP BigModelTeamPlanBizContext (entitlement still imports the type).
 * Does not own tip-ledger / verify-product-login gate.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const servicesSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const TEAM_PLAN_FILE = join(servicesSrc, "bigmodel/teamPlanApiKey.ts");
const ENTITLEMENT_FILE = join(servicesSrc, "bigmodel/codingPlanEntitlement.ts");

const DROP_SYMBOLS = [
  "createBigModelBizHeaders",
  "ensureBigModelTeamPlanProjectApiKey",
  "ensureBigModelTeamPlanProjectApiKeyWithStatus",
  "copyBigModelTeamPlanProjectApiKeySecret",
  "BigModelTeamPlanApiKeySummary",
  "BigModelTeamPlanApiKeyEnsureStatus",
  "BigModelTeamPlanApiKeyEnsureResult",
  "BigModelTeamPlanApiKeyEnsureDiagnostics",
  "BigModelBizEnvelopeDiagnostics",
] as const;

test("KEEP teamPlanApiKey.ts exports only BigModelTeamPlanBizContext", () => {
  assert.equal(existsSync(TEAM_PLAN_FILE), true);
  const src = readFileSync(TEAM_PLAN_FILE, "utf8");
  assert.match(src, /export interface BigModelTeamPlanBizContext/);
  for (const sym of DROP_SYMBOLS) {
    assert.equal(src.includes(sym), false, sym);
  }
});

test("DROP teamPlan ensure/copy/headers absent from services callers", () => {
  const files = [
    TEAM_PLAN_FILE,
    ENTITLEMENT_FILE,
    join(servicesSrc, "usage-stats/providers/bigmodelSubscriptionProvider.ts"),
    join(servicesSrc, "usage-stats/providers/bigmodelUsageQuotaProvider.ts"),
    join(servicesSrc, "model-provider/zaiStartPlanBilling.ts"),
  ];
  for (const file of files) {
    assert.equal(existsSync(file), true, file);
    const src = readFileSync(file, "utf8");
    for (const sym of [
      "createBigModelBizHeaders",
      "ensureBigModelTeamPlanProjectApiKey",
      "ensureBigModelTeamPlanProjectApiKeyWithStatus",
      "copyBigModelTeamPlanProjectApiKeySecret",
    ] as const) {
      assert.equal(src.includes(sym), false, `${file} :: ${sym}`);
    }
  }
});

test("KEEP entitlement still imports BigModelTeamPlanBizContext + fetchers", () => {
  const entitlement = readFileSync(ENTITLEMENT_FILE, "utf8");
  assert.match(entitlement, /BigModelTeamPlanBizContext/);
  assert.match(entitlement, /from "#src\/bigmodel\/teamPlanApiKey\.js"/);
  assert.match(entitlement, /export async function fetchPersonalCodingPlanEntitlement/);
  assert.match(entitlement, /export async function fetchTeamCodingPlanEntitlement/);
  assert.match(entitlement, /export type CodingPlanEntitlement/);
});
