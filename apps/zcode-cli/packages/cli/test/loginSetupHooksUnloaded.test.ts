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

test("create.ts no-model gate uses isModelSetupRequired (not isLoginRequired)", () => {
  const create = read("command-center/create.ts");
  assert.match(create, /async function isModelSetupRequired/);
  assert.match(create, /modelSetupRequired:\s*true/);
  assert.equal(create.includes("isLoginRequired"), false);
  assert.equal(/\bloginRequired\b/.test(create), false);
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

test("bootstrap no longer exports configureCodingPlanApiKey / ZCodeCliLoginError", () => {
  const bootstrapRoot = path.resolve(cliSrc, "../../bootstrap/src");
  const index = readFileSync(path.join(bootstrapRoot, "index.ts"), "utf8");
  assert.equal(index.includes("configureCodingPlanApiKey"), false);
  assert.equal(index.includes("ZCodeCliLoginError"), false);
  assert.equal(existsSync(path.join(bootstrapRoot, "coding-plan-api-key-config.ts")), false);
});

test("adapters auth no longer ships coding-plan-api-key OAuth→key resolver", () => {
  const authRoot = path.resolve(cliSrc, "../../adapters/src/auth");
  const index = readFileSync(path.join(authRoot, "index.ts"), "utf8");
  assert.equal(index.includes("coding-plan-api-key"), false);
  assert.equal(existsSync(path.join(authRoot, "coding-plan-api-key.ts")), false);
});

test("cli history and tui app-submit drop *-coding-plan-api-key login remnants", () => {
  const history = read("command-center/history.ts");
  assert.equal(history.includes("API_KEY_LOGIN_PATTERN"), false);
  assert.equal(history.includes("coding-plan-api-key"), false);
  const appSubmit = readFileSync(
    path.resolve(cliSrc, "../../tui/src/app-submit.ts"),
    "utf8",
  );
  assert.equal(appSubmit.includes("coding-plan-api-key"), false);
  assert.equal(appSubmit.includes("redactSensitivePromptForTranscript"), false);
});
