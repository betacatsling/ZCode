import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const hooksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/hooks");

test("useCodingPlanEntryPlanList.ts is removed", () => {
  assert.equal(existsSync(path.join(hooksDir, "useCodingPlanEntryPlanList.ts")), false);
});
