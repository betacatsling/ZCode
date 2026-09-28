import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderConfig } from "@zcode/provider";
import {
  isProviderStartupSyncPending,
  shouldBlockRootRender,
  shouldRedirectStartupToProductLogin,
} from "../src/lib/rootStartupGate.js";
import {
  buildPersonalProviderInitialConfig,
  validatePersonalProviderSetup,
} from "../src/settings/model-provider-section/personalProviderSetup.js";

test("startup render does not wait for product auth restore", () => {
  assert.equal(
    shouldBlockRootRender({
      isResolvingProviderStartupState: false,
      isRestoring: false,
      isBootstrappingInitialWorkspace: false,
    }),
    false,
  );
});

test("startup still waits for workspace restore and model view resolution", () => {
  assert.equal(
    shouldBlockRootRender({
      isResolvingProviderStartupState: true,
      isRestoring: false,
      isBootstrappingInitialWorkspace: false,
    }),
    true,
  );
  assert.equal(isProviderStartupSyncPending({ modelSelectionViewHydrated: false }), true);
  assert.equal(isProviderStartupSyncPending({ modelSelectionViewHydrated: true }), false);
});

test("missing account, family domain, or models never opens product login", () => {
  const cases = [
    { hasUser: false, providerFamilyDomain: null, hasUsableProvider: false, modelSelectionFailed: false },
    { hasUser: false, providerFamilyDomain: undefined, hasUsableProvider: true, modelSelectionFailed: false },
    { hasUser: true, providerFamilyDomain: null, hasUsableProvider: true, modelSelectionFailed: false },
    { hasUser: false, providerFamilyDomain: "zai", hasUsableProvider: false, modelSelectionFailed: true },
  ];
  for (const input of cases) {
    assert.equal(shouldRedirectStartupToProductLogin(input), false);
  }
});

test("personal provider setup accepts a non-official endpoint, key, and model", () => {
  const draft = {
    name: "AxonHub",
    baseUrl: "https://axon.example/v1/",
    apiType: "openai-responses" as const,
    apiKey: "sk-test",
    modelId: "step-2",
  };
  assert.equal(validatePersonalProviderSetup(draft), null);
  const config = buildPersonalProviderInitialConfig(draft);
  assert.equal(config.access.type, "api-key");
  assert.equal(config.access.apiKey, "sk-test");
  assert.equal(config.api.baseUrl, "https://axon.example/v1");
  assert.equal(config.api.type, "openai-responses");
  parseProviderConfig(config);
});

test("personal provider setup rejects a blank model without implying login", () => {
  assert.equal(
    validatePersonalProviderSetup({
      name: "",
      baseUrl: "https://stepfun.example/v1",
      apiType: "openai-chat-completions",
      apiKey: "key",
      modelId: "  ",
    }),
    "model-required",
  );
});
