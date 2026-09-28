import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProviderConfig } from "@zcode/provider";
import {
  isProviderStartupSyncPending,
  shouldBlockRootRender,
} from "../src/lib/rootStartupGate.js";
import {
  buildPersonalProviderInitialConfig,
  validatePersonalProviderSetup,
} from "../src/settings/model-provider-section/personalProviderSetup.js";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");

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

test("startup product-login redirect helper and loginEntryGuard toggle stay absent", () => {
  const gate = readFileSync(join(uiSrc, "lib/rootStartupGate.ts"), "utf8");
  const root = readFileSync(join(uiSrc, "Root.tsx"), "utf8");
  for (const needle of [
    "shouldRedirectStartupToProductLogin",
    "StartupProductLoginInput",
    "shouldEnableProviderAvailabilityLoginEntryGuard",
  ]) {
    assert.equal(gate.includes(needle), false, `rootStartupGate still has ${needle}`);
    assert.equal(root.includes(needle), false, `Root still has ${needle}`);
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
