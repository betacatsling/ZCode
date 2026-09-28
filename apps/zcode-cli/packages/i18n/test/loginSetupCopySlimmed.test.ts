import assert from "node:assert/strict";
import test from "node:test";
import { enUS } from "../src/locales/en-US.js";
import { zhCN } from "../src/locales/zh-CN.js";

for (const [name, copy] of [
  ["en-US", enUS],
  ["zh-CN", zhCN],
] as const) {
  test(`${name} loginSetup has no OAuth/API key option tree`, () => {
    const setup = copy.tui.loginSetup as Record<string, unknown>;
    assert.equal("options" in setup, false);
    assert.equal("pending" in setup, false);
    assert.equal("input" in setup, false);
    for (const value of Object.values(setup)) {
      assert.equal(typeof value, "string");
      assert.equal(String(value).includes("browser login"), false);
      assert.equal(String(value).includes("OAuth"), false);
    }
  });
}
