/**
 * Soft pin: chat.quota.action.switchModel / switchProvider / refresh absent (Ex4).
 * Does not own tip-ledger / verify-product-login gate.
 * KEEP chat.quota.action.upgrade (and unrelated chat.error.action.* / startPlan.switchModel).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const localesDir = join(dirname(fileURLToPath(import.meta.url)), "../src/i18n/locales");
const enUS = readFileSync(join(localesDir, "en-US.ts"), "utf8");
const zhCN = readFileSync(join(localesDir, "zh-CN.ts"), "utf8");

const DROP_KEYS = [
  "chat.quota.action.switchModel",
  "chat.quota.action.switchProvider",
  "chat.quota.action.refresh",
];

const KEEP_KEYS = ["chat.quota.action.upgrade"];

test("DROP chat.quota.action switchModel/switchProvider/refresh absent from en-US + zh-CN", () => {
  for (const locale of [enUS, zhCN]) {
    for (const key of DROP_KEYS) {
      assert.equal(locale.includes(`"${key}"`), false, key);
    }
  }
});

test("KEEP chat.quota.action.upgrade still present in en-US + zh-CN", () => {
  for (const locale of [enUS, zhCN]) {
    for (const key of KEEP_KEYS) {
      assert.equal(locale.includes(`"${key}"`), true, `keep ${key}`);
    }
  }
});
