import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("tui-login-state modelSetupRequiredResponse no longer scrubs /login OAuth push", () => {
  const source = read("../src/tui-login-state.ts");
  assert.match(source, /PRODUCT_LOGIN_REMOVED_MESSAGE/);
  assert.match(source, /modelSetupRequiredResponse/);
  assert.match(source, /tui\.modelSetupRequired/);
  assert.match(source, /copy\.message/);
  assert.match(source, /copy\.help/);
  assert.equal(source.includes("loginRequiredResponse"), false);
  assert.equal(source.includes("tui.loginRequired"), false);
  // Old scrub meant we still shipped /login in i18n; gate copy must not mention it.
  assert.equal(source.includes('replace(/\\/login/g'), false);
});
