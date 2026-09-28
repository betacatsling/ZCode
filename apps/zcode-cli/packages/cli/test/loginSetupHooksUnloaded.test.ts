import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const cliSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const read = (rel: string) => readFileSync(path.join(cliSrc, rel), "utf8");

test("login-flow.ts is removed", () => {
  assert.equal(existsSync(path.join(cliSrc, "command-center/login-flow.ts")), false);
});

test("create.ts /login always returns product-login-removed", () => {
  const create = read("command-center/create.ts");
  assert.match(create, /PRODUCT_LOGIN_REMOVED_MESSAGE/);
  assert.equal(create.includes("parseApiKeyLoginArgs"), false);
  assert.equal(create.includes("configureApiKey"), false);
  assert.equal(create.includes("login-flow"), false);
});

test("tui-prompt-handler no longer wires loginSetup API key / OAuth hooks", () => {
  const handler = read("tui-prompt-handler.ts");
  assert.equal(handler.includes("configureApiKeyForTui"), false);
  assert.equal(handler.includes("configureApiKey:"), false);
  assert.equal(handler.includes("loginForTui"), false);
  assert.equal(handler.includes("loginBigmodelForTui"), false);
});

test("tui-auth keeps login/logout removed throws and drops configureApiKeyForTui", () => {
  const auth = read("tui-auth.ts");
  assert.match(auth, /loginForTui/);
  assert.match(auth, /logoutForTui/);
  assert.match(auth, /PRODUCT_LOGIN_REMOVED_MESSAGE/);
  assert.equal(auth.includes("configureApiKeyForTui"), false);
  assert.equal(auth.includes("configureCodingPlanApiKey"), false);
});

test("cli-types RunDependencies no longer injects configureCodingPlanApiKey", () => {
  const types = read("cli-types.ts");
  assert.equal(types.includes("configureCodingPlanApiKey"), false);
  assert.equal(types.includes("ConfigureCodingPlanApiKeyOptions"), false);
});
