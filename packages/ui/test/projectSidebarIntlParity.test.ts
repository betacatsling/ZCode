import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

test("Project sidebar strings stay complete in both shipped locales", () => {
  const enKeys = Object.keys(enUS)
    .filter((key) => key.startsWith("projectSidebar."))
    .sort();
  const zhKeys = Object.keys(zhCN)
    .filter((key) => key.startsWith("projectSidebar."))
    .sort();

  assert.deepEqual(zhKeys, enKeys);
});
