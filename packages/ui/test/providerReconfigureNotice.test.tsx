import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  PROVIDER_RECONFIGURE_REQUIRED,
  openProviderReconfigureSettings,
  providerReconfigureReceiptFromAck,
  resolveProviderReconfigureNotice,
} from "../src/v4/providerReconfigureNotice.js";
import {
  CapabilityProviderReconfigureNotice,
  ProviderReconfigureNotice,
  PROVIDER_RECONFIGURE_NOTICE_TESTID,
} from "../src/v4/ProviderReconfigureNotice.js";

const SECRET_KEY = "sk-live-never-render-me";
const SECRET_URL = "https://gateway.internal.example/v1";
const attention = {
  reason: "auth_failed",
  action: "reconfigure-provider" as const,
  providerId: "provider-two",
  modelId: "model-two",
  statusCode: 401,
  retryable: false,
};

test("session.error provider-reconfigure-required names the session's host-managed Provider", () => {
  const lastError = {
    code: PROVIDER_RECONFIGURE_REQUIRED,
    message: `Provider credential rejected (${SECRET_KEY} @ ${SECRET_URL})`,
    at: 42,
  };
  const notice = resolveProviderReconfigureNotice({
    sessionId: "s-1",
    phase: "error",
    lastError,
    sessionProviderId: "provider-one",
    sessionModelId: "model-one",
  });
  assert.deepEqual(notice, {
    source: "session-error",
    providerId: "provider-one",
    modelId: "model-one",
    key: "session-error:s-1:42",
  });
  // A newer turn (phase no longer error) must not keep a stale hint.
  assert.equal(
    resolveProviderReconfigureNotice({
      sessionId: "s-1",
      phase: "running",
      lastError,
      sessionProviderId: "provider-one",
    }),
    null,
  );
  assert.equal(
    resolveProviderReconfigureNotice({
      sessionId: "s-1",
      phase: "error",
      lastError: { ...lastError, code: "backend-failure" },
      sessionProviderId: "provider-one",
    }),
    null,
  );
  // Harness-managed sessions project provider "" and never get a Provider hint.
  assert.equal(
    resolveProviderReconfigureNotice({
      sessionId: "s-1",
      phase: "error",
      lastError,
      sessionProviderId: "",
    }),
    null,
  );
});

test("a rejected send receipt with provider-reconfigure-required yields a hint for that session only", () => {
  const rejected = {
    commandId: "c-1",
    status: "rejected",
    reasonCode: PROVIDER_RECONFIGURE_REQUIRED,
  };
  const receipt = providerReconfigureReceiptFromAck(rejected, "s-1");
  assert.deepEqual(receipt, { sessionId: "s-1", commandId: "c-1" });
  assert.equal(providerReconfigureReceiptFromAck({ ...rejected, status: "accepted" }, "s-1"), null);
  assert.equal(
    providerReconfigureReceiptFromAck({ ...rejected, reasonCode: "unsupported" }, "s-1"),
    null,
  );
  assert.equal(providerReconfigureReceiptFromAck(rejected, null), null);

  assert.deepEqual(
    resolveProviderReconfigureNotice({
      sessionId: "s-1",
      phase: "idle",
      receipt,
      sessionProviderId: "provider-one",
    }),
    { source: "command-receipt", providerId: "provider-one", key: "command-receipt:s-1:c-1" },
  );
  assert.equal(
    resolveProviderReconfigureNotice({
      sessionId: "s-2",
      phase: "idle",
      receipt,
      sessionProviderId: "provider-one",
    }),
    null,
  );
});

test("capability credentialAttention yields a hint for exactly the attention's Provider", () => {
  assert.deepEqual(
    resolveProviderReconfigureNotice({ sessionId: null, capabilityAttention: attention }),
    {
      source: "capability",
      providerId: "provider-two",
      modelId: "model-two",
      key: "capability:provider-two:model-two",
    },
  );
  assert.equal(
    resolveProviderReconfigureNotice({ sessionId: null, capabilityAttention: null }),
    null,
  );
  assert.equal(resolveProviderReconfigureNotice({ sessionId: null }), null);
});

test("opening settings deep-links the model Provider section to that Provider", () => {
  const calls: unknown[] = [];
  openProviderReconfigureSettings(
    "provider-two",
    () => calls.push("open"),
    (section, options) => calls.push([section, options]),
  );
  assert.deepEqual(calls, [["modelProvider", { modelProviderId: "provider-two" }], "open"]);
  // No tab store (e.g. embedded web) still records the intent and does not throw.
  const intents: unknown[] = [];
  openProviderReconfigureSettings("provider-two", undefined, (section, options) =>
    intents.push([section, options]),
  );
  assert.equal(intents.length, 1);
});

function render(locale: "zh-CN" | "en-US", providerLabel: string | undefined) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={locale}>
      <ProviderReconfigureNotice
        notice={{ source: "capability", providerId: "provider-two", key: "k" }}
        providerLabel={providerLabel}
        onOpenSettings={() => {}}
        onDismiss={() => {}}
      />
    </ZCodeIntlProvider>,
  );
}

function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ");
}

test("notice renders reconfigure copy, the Provider name and a settings action, never key or URL", () => {
  const zh = render("zh-CN", "Team Gateway");
  assert.match(zh, /role="alert"/);
  assert.match(zh, new RegExp(`data-testid="${PROVIDER_RECONFIGURE_NOTICE_TESTID}"`));
  assert.match(zh, /data-provider-id="provider-two"/);
  assert.match(zh, /需要重新配置 Provider/);
  assert.match(visibleText(zh), /Team Gateway/);
  assert.match(zh, /<button[^>]*>打开 Provider 设置<\/button>/);
  const en = render("en-US", "Team Gateway");
  assert.match(en, /Provider needs to be reconfigured/);
  assert.match(en, /<button[^>]*>Open Provider settings<\/button>/);
  // Without a display name the id is not shown as a name (it may be an opaque UUID).
  const unnamed = render("zh-CN", undefined);
  assert.doesNotMatch(visibleText(unnamed), /provider-two/);
  assert.match(unnamed, /需要重新配置 Provider/);
  for (const markup of [zh, en, unnamed]) {
    assert.doesNotMatch(markup, /sk-|https?:\/\//);
  }
});

test("reconfigure copy exists in both locales", () => {
  for (const id of [
    "chat.providerReconfigure.title",
    "chat.providerReconfigure.messageNamed",
    "chat.providerReconfigure.messageUnnamed",
    "chat.providerReconfigure.open",
    "chat.providerReconfigure.dismiss",
  ]) {
    assert.ok(zhCN[id], `zh-CN missing ${id}`);
    assert.ok(enUS[id], `en-US missing ${id}`);
  }
});

test("create-form capability notice names the attention's Provider and renders nothing without attention", () => {
  const providers = [
    { providerId: "provider-one", providerName: "Primary" },
    { providerId: "provider-two", providerName: "Team Gateway" },
  ];
  const withAttention = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <CapabilityProviderReconfigureNotice attention={attention} providers={providers} />
    </ZCodeIntlProvider>,
  );
  assert.match(withAttention, /data-provider-id="provider-two"/);
  assert.match(withAttention, /data-notice-source="capability"/);
  assert.match(visibleText(withAttention), /Team Gateway/);
  assert.doesNotMatch(visibleText(withAttention), /Primary/);
  assert.match(withAttention, /打开 Provider 设置/);
  const without = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <CapabilityProviderReconfigureNotice attention={undefined} providers={providers} />
    </ZCodeIntlProvider>,
  );
  assert.equal(without, "");
});
