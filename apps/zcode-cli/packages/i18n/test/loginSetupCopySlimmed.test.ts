import assert from "node:assert/strict";
import test from "node:test";
import { enUS } from "../src/locales/en-US.js";
import { zhCN } from "../src/locales/zh-CN.js";

for (const [name, copy] of [
  ["en-US", enUS],
  ["zh-CN", zhCN],
] as const) {
  test(`${name} loginSetup i18n key removed (folded into product-login-removed stubs)`, () => {
    const tui = copy.tui as Record<string, unknown>;
    assert.equal("loginSetup" in tui, false);
  });
}
