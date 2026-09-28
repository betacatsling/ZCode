import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import path from "node:path";

const mainDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(mainDir, "../..");
const chromePath = path.join(mainDir, "desktopWindowChrome.ts");
const ipcRemotePath = path.join(mainDir, "desktopMainIpcRemote.ts");
const preloadPath = path.join(desktopRoot, "src/preload/codingPlanWebview.ts");
const tsupPath = path.join(desktopRoot, "tsup.config.ts");

test("codingPlanWebview preload is removed", () => {
  assert.equal(existsSync(preloadPath), false);
});

test("tsup no longer builds codingPlanWebview preload", () => {
  const text = readFileSync(tsupPath, "utf8");
  assert.equal(text.includes("codingPlanWebview"), false);
});

test("desktopWindowChrome drops Coding Plan / PayPal special cases", () => {
  const text = readFileSync(chromePath, "utf8");
  for (const needle of [
    "isCodingPlanEmbeddedWebviewSrc",
    "isCodingPlanWebviewUrl",
    "isCodingPlanPaymentCallbackUrl",
    "isCodingPlanPaypalNavigationUrl",
    "isAllowedCodingPlanEmbeddedNavigationUrl",
    "isCodingPlanGuest",
    "pendingWebviewCodingPlanGuestFlags",
    "codingPlanWebviewPreloadPath",
    "isTrustedCodingPlanWebviewOrigin",
  ]) {
    assert.equal(text.includes(needle), false, `unexpected leftover: ${needle}`);
  }
  // Ordinary browser-pane attach path must stay.
  assert.match(text, /will-attach-webview/);
  assert.match(text, /did-attach-webview/);
  assert.match(text, /embeddedBrowserJavaScriptDialogPreloadPath/);
});

test("desktopMainIpcRemote drops Coding Plan keep-in-webview openExternal bypass", () => {
  const text = readFileSync(ipcRemotePath, "utf8");
  for (const needle of [
    "shouldKeepCodingPlanOpenExternalInWebview",
    "isCodingPlanPaypalNavigationUrl",
    "isCodingPlanPaymentCallbackUrl",
    "isAllowedCodingPlanEmbeddedNavigationUrl",
    "isTrustedCodingPlanWebviewOrigin",
    "load coding-plan callback in webview",
  ]) {
    assert.equal(text.includes(needle), false, `unexpected leftover: ${needle}`);
  }
  assert.match(text, /PlatformChannels\.OpenExternal/);
  assert.match(text, /shell\.openExternal/);
});

const handlersPath = path.join(mainDir, "desktopCommandHandlers.ts");
const channelsPath = path.resolve(desktopRoot, "../shared/src/channels.ts");
const platformPath = path.resolve(desktopRoot, "../shared/src/platform.ts");

test("clearCodingPlanWebviewStorage and partition are removed", () => {
  const handlers = readFileSync(handlersPath, "utf8");
  for (const needle of [
    "clearCodingPlanWebviewStorage",
    "CODING_PLAN_WEBVIEW_PARTITION",
    "persist:zcode-coding-plan",
  ]) {
    assert.equal(handlers.includes(needle), false, `unexpected leftover: ${needle}`);
  }

  const platform = readFileSync(platformPath, "utf8");
  assert.equal(platform.includes("ClearCodingPlanWebviewStorage"), false);

  const channels = readFileSync(channelsPath, "utf8");
  for (const needle of [
    "CodingPlanWebviewChannels",
    "CodingPlanPurchaseCompletePayload",
    "CodingPlanWebviewLocale",
    "CodingPlanWebviewLangChangeDetail",
    "persist:zcode-coding-plan",
  ]) {
    assert.equal(channels.includes(needle), false, `unexpected leftover: ${needle}`);
  }
});
