import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), "utf8");

const enUS = readUi("../src/i18n/locales/en-US.ts");
const zhCN = readUi("../src/i18n/locales/zh-CN.ts");
const shareImportIntent = readUi("../src/root/shareImportIntent.ts");
const botsUi = readUi("../src/botsUi.ts");

/** Dead product-login / Coding Plan /login locale keys — must stay absent. */
const DEAD_PRODUCT_LOGIN_KEYS = [
  "settings.modelProvider.codingPlan.login",
  "settings.modelProvider.codingPlan.productsLoginRequired",
  "settings.modelProvider.codingPlan.start.loginEnable",
  "settings.modelProvider.codingPlan.start.loginTrial",
  "settings.usage.entitlementLoginRequired",
  "settings.usage.entitlementStatusLoginRequired",
  "sidebar.usage.plan.loginRequired",
] as const;

/** Orphan Welcome / login.* shell keys (Root OAuth shell unloaded) — must stay absent. */
const DEAD_WELCOME_LOGIN_ORPHAN_KEYS = [
  "welcome.username",
  "welcome.password",
  "welcome.login",
  "welcome.loggingIn",
  "welcome.loginFailed",
  "login.title",
  "login.description",
  "login.oauth.activeProviderHint",
  "login.oauth.loadingProviders",
  "login.oauth.noProviders",
  "login.oauth.button",
  "login.oauth.button.zai",
  "login.oauth.button.bigmodel",
  "login.oauth.waiting",
  "login.oauth.loginFailure",
  "login.oauth.cancel",
  "login.oauth.retry",
  "login.expired.title",
  "login.expired.description",
  "login.expired.action",
  "login.expired.restart",
  "login.useApiKey",
  "login.apiKey.title",
  "login.apiKey.placeholder",
  "login.apiKey.providerLabel",
  "login.apiKey.provider.zai",
  "login.apiKey.provider.bigmodel",
  "login.apiKey.getApiKey",
  "login.apiKey.cancel",
  "login.apiKey.continue",
  "login.apiKey.emptyError",
  "login.apiKey.providerMissingError",
  "login.apiKey.saveError",
  "login.apiKey.skipError",
  "login.skip",
] as const;

test("UI locales drop dead product loginRequired / Coding Plan login keys", () => {
  for (const key of DEAD_PRODUCT_LOGIN_KEYS) {
    const needle = `"${key}"`;
    assert.equal(enUS.includes(needle), false, `en-US still has ${key}`);
    assert.equal(zhCN.includes(needle), false, `zh-CN still has ${key}`);
  }
});

test("UI locales drop orphan Welcome / login.* shell keys", () => {
  for (const key of DEAD_WELCOME_LOGIN_ORPHAN_KEYS) {
    const needle = `"${key}"`;
    assert.equal(enUS.includes(needle), false, `en-US still has ${key}`);
    assert.equal(zhCN.includes(needle), false, `zh-CN still has ${key}`);
  }
});

test("ZCode account share-import signInRequired copy stays (not product login)", () => {
  assert.match(enUS, /"conversationShare\.import\.signInRequired"/);
  assert.match(zhCN, /"conversationShare\.import\.signInRequired"/);
  assert.match(shareImportIntent, /conversationShare\.import\.signInRequired/);
  assert.equal(shareImportIntent.includes("loginRequired"), false);
});

test("live welcome.title + bot regionTag keys stay (not product OAuth shell)", () => {
  assert.match(enUS, /"welcome\.title"/);
  assert.match(zhCN, /"welcome\.title"/);
  // #112: regionTag moved off login.oauth → settings.modelProvider
  assert.equal(enUS.includes('"login.oauth.regionTag.zai"'), false);
  assert.equal(zhCN.includes('"login.oauth.regionTag.zai"'), false);
  assert.equal(enUS.includes('"login.oauth.regionTag.bigmodel"'), false);
  assert.equal(zhCN.includes('"login.oauth.regionTag.bigmodel"'), false);
  assert.equal(botsUi.includes("login.oauth.regionTag"), false);
  assert.match(enUS, /"settings\.modelProvider\.regionTag\.zai"/);
  assert.match(zhCN, /"settings\.modelProvider\.regionTag\.zai"/);
  assert.match(enUS, /"settings\.modelProvider\.regionTag\.bigmodel"/);
  assert.match(zhCN, /"settings\.modelProvider\.regionTag\.bigmodel"/);
  assert.match(botsUi, /settings\.modelProvider\.regionTag\.zai/);
  assert.match(botsUi, /settings\.modelProvider\.regionTag\.bigmodel/);
});
