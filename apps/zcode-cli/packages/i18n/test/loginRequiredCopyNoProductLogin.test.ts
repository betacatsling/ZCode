import assert from "node:assert/strict";
import test from "node:test";
import { enUS } from "../src/locales/en-US.js";
import { zhCN } from "../src/locales/zh-CN.js";

for (const [name, copy] of [
  ["en-US", enUS],
  ["zh-CN", zhCN],
] as const) {
  test(`${name} modelSetupRequired copy does not push product /login`, () => {
    const block = copy.tui.modelSetupRequired;
    for (const value of Object.values(block)) {
      assert.equal(value.includes("/login"), false, value);
      assert.equal(/Coding Plan 账号|Coding Plan account/i.test(value), false, value);
    }
  });

  test(`${name} CLI help marks login/logout as removed`, () => {
    const help = copy.cli.help("0.0.0-test");
    assert.match(help, /login[\s\S]*removed|login[\s\S]*已移除/i);
    assert.equal(help.includes("browser login"), false);
    assert.equal(help.includes("Z.AI OAuth 登录"), false);
  });

  test(`${name} tui copy dropped loginRequired/loginSetup key names`, () => {
    const tui = copy.tui as Record<string, unknown>;
    assert.equal("loginRequired" in tui, false);
    assert.equal("loginSetup" in tui, false);
    assert.equal("modelSetupRequired" in tui, true);
  });
}
