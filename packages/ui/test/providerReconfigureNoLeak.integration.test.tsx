/**
 * End-to-end no-leak guard for the Provider reconfigure hint: a real Pi host (loopback Provider
 * whose configured key and upstream error body both contain `sk-leak`), the real desktop
 * agent-host transport (ack), and the real notice resolver + component (text).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commandAckSchema, conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  LEAK_MARKER,
  createProviderFailureHost,
  startFailingProvider,
} from "../../services/test/fixtures/providerFailureHost.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { createAgentHostConversationTransport } from "../src/v4/agentHostConversationTransport.js";
import { ProviderReconfigureNotice } from "../src/v4/ProviderReconfigureNotice.js";
import {
  providerReconfigureReceiptFromAck,
  resolveProviderReconfigureNotice,
  type ProviderReconfigureNoticeModel,
} from "../src/v4/providerReconfigureNotice.js";

type Host = Awaited<ReturnType<typeof createProviderFailureHost>>;

async function withHost(
  run: (host: Host, provider: { failWith?: number; requests: number }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-ui-reconfigure-no-leak-"));
  const provider = await startFailingProvider();
  const host = await createProviderFailureHost(root, provider.origin);
  try {
    await run(host, provider.state);
  } finally {
    await host.dispose();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

function transportFor(host: Host, spec: ReturnType<Host["specFor"]>) {
  const client = host.target as unknown as Parameters<
    typeof createAgentHostConversationTransport
  >[0];
  return createAgentHostConversationTransport(client, {
    spec,
    clientMode: "desktop-continuous",
    runtimePolicy: "start-if-needed",
  });
}

function sendText(spec: ReturnType<Host["specFor"]>, commandId: string) {
  const selection = spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection : null;
  assert.ok(selection);
  return {
    commandId,
    clientId: "client-no-leak",
    sessionId: spec.hostSessionId,
    type: "sendText" as const,
    payload: {
      text: `prompt ${commandId}`,
      modelSelection: selection,
      requestedDelivery: "startNow" as const,
    },
    issuedAt: Date.now(),
  };
}

function renderNotice(notice: ProviderReconfigureNoticeModel) {
  return ["zh-CN", "en-US"].map((locale) =>
    renderToStaticMarkup(
      <ZCodeIntlProvider initialLocale={locale as "zh-CN" | "en-US"}>
        <ProviderReconfigureNotice
          notice={notice}
          providerLabel="Failing Provider"
          onOpenSettings={() => {}}
          onDismiss={() => {}}
        />
      </ZCodeIntlProvider>,
    ),
  );
}

function assertNoLeak(label: string, value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.equal(text.includes(LEAK_MARKER), false, `${label} must not carry ${LEAK_MARKER}`);
}

test(
  "401: rejected receipt message, V4 ack and notice never carry the key or upstream body",
  { timeout: 60_000 },
  async () => {
    await withHost(async (host, provider) => {
      const spec = host.specFor("ui-no-leak-401");
      await host.target.create(spec);
      const transport = transportFor(host, spec);
      try {
        provider.failWith = 401;
        assert.equal((await transport.sendCommand(sendText(spec, "t1"))).status, "accepted");
        await host.target.waitForIdle(spec);
        // Positive control: the Provider was called with the sk-leak key and answered with a body
        // that echoes it.
        const requestsAfter401 = provider.requests;
        assert.ok(requestsAfter401 >= 1);
        const snapshot = conversationSnapshotSchema.parse(await host.target.snapshot(spec));
        assert.equal(snapshot.control.lastError?.code, "provider-reconfigure-required");
        assert.equal(snapshot.control.lastError?.failure?.statusCode, 401);

        const ack = await transport.sendCommand(sendText(spec, "t2"));
        assert.equal(ack.status, "rejected");
        assert.equal(ack.reasonCode, "provider-reconfigure-required");
        assert.equal(ack.failure?.providerId, host.providerId);
        assert.equal(ack.failure?.statusCode, 401);
        assert.equal(provider.requests, requestsAfter401, "admission refused before any request");
        const receipt = await host.target.queryCommand(spec, "t2");
        assert.ok(receipt?.message, "host receipt carries a message");
        assert.equal(ack.message, receipt.message);
        assert.deepEqual(commandAckSchema.parse(ack), ack);

        const pending = providerReconfigureReceiptFromAck(ack, spec.hostSessionId);
        const notice = resolveProviderReconfigureNotice({
          sessionId: spec.hostSessionId,
          phase: snapshot.control.phase,
          lastError: snapshot.control.lastError,
          receipt: pending,
          sessionProviderId: snapshot.config.provider,
          sessionModelId: snapshot.config.model,
        });
        assert.equal(notice?.source, "command-receipt");
        assert.equal(notice?.providerId, host.providerId);
        const markup = renderNotice(notice!);

        assertNoLeak("receipt.message", receipt.message);
        assertNoLeak("receipt", receipt);
        assertNoLeak("ack.message", ack.message);
        assertNoLeak("ack", ack);
        assertNoLeak("snapshot lastError", snapshot.control.lastError);
        assertNoLeak("notice", notice);
        for (const html of markup) assertNoLeak("notice markup", html);
      } finally {
        transport.dispose();
      }
    });
  },
);

test(
  "403 turn path: lastError message and notice never carry the key or upstream body; typed failure names the Provider without config",
  { timeout: 60_000 },
  async () => {
    await withHost(async (host, provider) => {
      const spec = host.specFor("ui-no-leak-403");
      await host.target.create(spec);
      const transport = transportFor(host, spec);
      try {
        provider.failWith = 403;
        const ack = await transport.sendCommand(sendText(spec, "t1"));
        assert.equal(ack.status, "accepted");
        assert.equal(Object.hasOwn(ack, "failure"), false);
        await host.target.waitForIdle(spec);
        assert.ok(provider.requests >= 1, "the Provider answered 403 with the echo body");
        const snapshot = conversationSnapshotSchema.parse(await host.target.snapshot(spec));
        const lastError = snapshot.control.lastError;
        assert.equal(lastError?.code, "provider-reconfigure-required");
        assert.equal(lastError?.failure?.statusCode, 403);
        assert.equal(lastError?.failure?.retryable, false);
        assert.equal(snapshot.control.phase, "error");

        assertNoLeak("ack", ack);
        assertNoLeak("snapshot lastError", lastError);
        assertNoLeak("snapshot", snapshot);
        const notices = [snapshot.config.provider, ""].map((sessionProviderId) =>
          resolveProviderReconfigureNotice({
            sessionId: spec.hostSessionId,
            phase: snapshot.control.phase,
            lastError,
            sessionProviderId,
            sessionModelId: sessionProviderId ? snapshot.config.model : "",
          }),
        );
        for (const notice of notices) {
          assert.equal(notice?.source, "session-error");
          assert.equal(notice?.providerId, host.providerId);
          assertNoLeak("notice", notice);
          for (const html of renderNotice(notice!)) assertNoLeak("notice markup", html);
        }
      } finally {
        transport.dispose();
      }
    });
  },
);
