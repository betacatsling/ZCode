import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const toolbar = readUi("../src/v4/composer/V4ComposerToolbar.tsx");
const startPlan = readUi("../src/chat-input-toolbar/StartPlanContextBalance.tsx");
const contextUsage = readUi("../src/chat-input-toolbar/contextUsage.tsx");
const codingPlanUsage = readUi("../src/chat-input-toolbar/CodingPlanContextUsage.tsx");
const zhCN = readUi("../src/i18n/locales/zh-CN.ts");
const enUS = readUi("../src/i18n/locales/en-US.ts");

test("composer toolbar does not open the Coding Plan upgrade dialog", () => {
  assert.equal(toolbar.includes("useCodingPlanUpgradeDialog"), false);
  assert.equal(toolbar.includes("openCodingPlanUpgrade"), false);
  assert.equal(toolbar.includes("onUpgradeClick"), false);
  assert.equal(toolbar.includes("handleOpenStartPlanUpgrade"), false);
});

test("start plan balance and context usage do not render an upgrade action", () => {
  assert.equal(startPlan.includes("onUpgradeClick"), false);
  assert.equal(startPlan.includes("CodingPlanEntryButton"), false);
  assert.equal(startPlan.includes("chat.quota.action.upgrade"), false);
  assert.equal(contextUsage.includes("onUpgradeClick"), false);
});

test("toolbar not_authenticated copy points at API Key instead of product login", () => {
  assert.equal(codingPlanUsage.includes("sidebar.usage.plan.loginRequired"), false);
  assert.match(codingPlanUsage, /chat\.quota\.plan\.productLoginRemoved/);
  assert.match(
    zhCN,
    /"chat\.quota\.plan\.productLoginRemoved":\s*"产品登录已移除。请在设置中配置 API Key 后查看额度。"/,
  );
  assert.match(
    enUS,
    /"chat\.quota\.plan\.productLoginRemoved":\s*"Product sign-in has been removed\. Configure an API Key in Settings to view quota\."/,
  );
});
