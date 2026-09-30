/**
 * Remote-target sessions: the Provider reconfigure notice must not open this device's (local)
 * Provider settings, because Settings → Model Provider always edits the local Host. Local
 * sessions keep the settings action.
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import * as noticeModel from "../src/v4/providerReconfigureNotice.js";
import * as noticeView from "../src/v4/ProviderReconfigureNotice.js";

type Locale = "zh-CN" | "en-US";
// Namespace access so a missing export fails its assertions instead of the whole file.
const model = noticeModel as unknown as Record<string, unknown> & typeof noticeModel;
const view = noticeView as unknown as Record<string, unknown> & typeof noticeView;
type Target = { kind: "local" } | { kind: "remote"; label?: string };
const reconfigureTarget = (input: Record<string, unknown>) =>
  (model.providerReconfigureTarget as (input: Record<string, unknown>) => Target)(input);

const SECRET = "sk-leak-never-render";
const OPEN = { "zh-CN": "打开 Provider 设置", "en-US": "Open Provider settings" };
const notice = {
  source: "session-error" as const,
  providerId: "provider-remote",
  key: "session-error:s-1:1",
};

function renderNotice(locale: Locale, target?: Target, providerLabel = "Team Gateway") {
  const Notice = view.ProviderReconfigureNotice as React.ComponentType<Record<string, unknown>>;
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={locale}>
      <Notice
        notice={notice}
        providerLabel={providerLabel}
        onOpenSettings={() => {
          throw new Error("must not be called during render");
        }}
        onDismiss={() => {}}
        {...(target ? { target } : {})}
      />
    </ZCodeIntlProvider>,
  );
}

const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, " ");

test("the session's target scope follows the pane's remote workspace facts", () => {
  assert.equal(typeof model.providerReconfigureTarget, "function");
  assert.deepEqual(reconfigureTarget({}), { kind: "local" });
  assert.deepEqual(reconfigureTarget({ workspaceIdentity: " ", remoteSessionId: "" }), {
    kind: "local",
  });
  assert.deepEqual(reconfigureTarget({ workspaceIdentity: "remote-ws" }), { kind: "remote" });
  assert.deepEqual(reconfigureTarget({ remoteSessionId: "remote-session" }), { kind: "remote" });
  assert.deepEqual(
    reconfigureTarget({ remoteSessionId: "remote-session", remoteTargetLabel: "  gpu-box  " }),
    { kind: "remote", label: "gpu-box" },
  );
  // A label alone never makes a local session remote.
  assert.deepEqual(reconfigureTarget({ remoteTargetLabel: "gpu-box" }), { kind: "local" });
});

test("remote session notice has no local settings action and says where to reconfigure", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const named = renderNotice(locale, { kind: "remote", label: "gpu-box" });
    assert.match(named, /data-notice-scope="remote"/);
    assert.doesNotMatch(named, new RegExp(OPEN[locale]));
    assert.match(visibleText(named), /gpu-box/);
    assert.match(visibleText(named), /Team Gateway/);
    // Dismiss stays available.
    assert.match(named, locale === "zh-CN" ? /稍后/ : /Later/);
    const unnamed = renderNotice(locale, { kind: "remote" });
    assert.match(unnamed, /data-notice-scope="remote"/);
    assert.doesNotMatch(unnamed, new RegExp(OPEN[locale]));
    const messages = locale === "zh-CN" ? zhCN : enUS;
    const unnamedCopy = messages["chat.providerReconfigure.remoteUnnamed"];
    assert.ok(unnamedCopy && visibleText(unnamed).includes(unnamedCopy.slice(0, 12)));
    for (const markup of [named, unnamed]) assert.doesNotMatch(markup, /sk-|https?:\/\//);
  }
  // Local and unspecified targets are marked local (and keep the action, see the next test).
  assert.match(renderNotice("en-US"), /data-notice-scope="local"/);
  assert.match(renderNotice("en-US", { kind: "local" }), /data-notice-scope="local"/);
  assert.match(renderNotice("zh-CN", { kind: "remote", label: "gpu-box" }), /远程目标/);
  assert.match(renderNotice("en-US", { kind: "remote", label: "gpu-box" }), /remote target/);
});

test("local session notice keeps the settings action (today's behaviour)", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const markup of [renderNotice(locale), renderNotice(locale, { kind: "local" })]) {
      assert.match(markup, new RegExp(`<button[^>]*>${OPEN[locale]}</button>`));
    }
  }
});

test("create-form capability notice for a remote target has no local settings action", () => {
  const Capability = view.CapabilityProviderReconfigureNotice as React.ComponentType<
    Record<string, unknown>
  >;
  const attention = {
    reason: "auth_failed",
    action: "reconfigure-provider" as const,
    providerId: "provider-remote",
    statusCode: 403,
    retryable: false,
  };
  const providers = [{ providerId: "provider-remote", providerName: "Team Gateway" }];
  const render = (target?: Target) =>
    renderToStaticMarkup(
      <ZCodeIntlProvider initialLocale="en-US">
        <Capability attention={attention} providers={providers} {...(target ? { target } : {})} />
      </ZCodeIntlProvider>,
    );
  const remote = render({ kind: "remote", label: "gpu-box" });
  assert.match(remote, /data-notice-scope="remote"/);
  assert.doesNotMatch(remote, /Open Provider settings/);
  assert.match(visibleText(remote), /gpu-box/);
  assert.match(render(), /Open Provider settings/);
});

test("remote notice resolved from a leaking session error never renders the secret", () => {
  const lastError = {
    code: noticeModel.PROVIDER_RECONFIGURE_REQUIRED,
    message: `Provider rejected ${SECRET} at https://gateway.internal.example/v1`,
    at: 1,
    failure: {
      reason: "auth_failed",
      action: "reconfigure-provider" as const,
      providerId: "provider-remote",
      statusCode: 401,
      retryable: false,
    },
  };
  const resolved = noticeModel.resolveProviderReconfigureNotice({
    sessionId: "s-1",
    phase: "error",
    lastError,
    sessionProviderId: "",
  });
  assert.ok(resolved);
  const Notice = view.ProviderReconfigureNotice as React.ComponentType<Record<string, unknown>>;
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <Notice
        notice={resolved}
        providerLabel="Team Gateway"
        onOpenSettings={() => {}}
        target={{ kind: "remote", label: "gpu-box" }}
      />
    </ZCodeIntlProvider>,
  );
  assert.equal(markup.includes(SECRET), false);
  assert.doesNotMatch(markup, /sk-|https?:\/\//);
  assert.match(markup, /data-notice-scope="remote"/);
});

test("remote reconfigure copy exists in both locales", () => {
  for (const id of [
    "chat.providerReconfigure.remoteNamed",
    "chat.providerReconfigure.remoteUnnamed",
  ]) {
    assert.ok(zhCN[id], `zh-CN missing ${id}`);
    assert.ok(enUS[id], `en-US missing ${id}`);
  }
  assert.match(zhCN["chat.providerReconfigure.remoteNamed"]!, /\{target\}/);
  assert.match(enUS["chat.providerReconfigure.remoteNamed"]!, /\{target\}/);
});
