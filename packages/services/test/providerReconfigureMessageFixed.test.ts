/**
 * Host-side guard for the Provider reconfigure texts clients show or copy: the rejected send
 * receipt (401 admission) and the session.error / control.lastError (401 and 403 turn path) use
 * fixed templates built only from ids, the HTTP status and the safe reason token. The configured
 * key and the upstream error body both contain `sk-leak`; neither may reach any of them.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCommandReceipt } from "@zcode/shared/agent-host";
import {
  LEAK_MARKER,
  createProviderFailureHost,
  startFailingProvider,
} from "./fixtures/providerFailureHost.js";

type Host = Awaited<ReturnType<typeof createProviderFailureHost>>;

async function withHost(
  run: (host: Host, provider: { failWith?: number; requests: number }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-reconfigure-message-fixed-"));
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

function send(spec: ReturnType<Host["specFor"]>, turnId: string) {
  return {
    type: "send" as const,
    commandId: `${turnId}-command`,
    hostSessionId: spec.hostSessionId,
    turnId,
    text: `prompt ${turnId}`,
  };
}

function turnErrorMessage(providerId: string, status: number) {
  return `Provider ${providerId} rejected the credentials for failing-model (HTTP ${status}): auth_failed. Reconfigure this Provider or explicitly choose another model; no other Provider was used.`;
}

async function failTurn(host: Host, spec: ReturnType<Host["specFor"]>, status: number) {
  const accepted = await host.target.dispatch(spec, send(spec, "t1"));
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.message, undefined);
  await host.target.waitForIdle(spec);
  const snapshot = await host.target.snapshot(spec);
  assert.equal(snapshot.control.lastError?.code, "provider-reconfigure-required");
  assert.equal(snapshot.control.lastError?.message, turnErrorMessage(host.providerId, status));
  const errors = (await host.target.eventsSince(spec, 0)).filter(
    (event) => event.kind === "session.error",
  );
  assert.equal(errors.length, 1);
  assert.equal(
    errors[0]?.kind === "session.error" && errors[0].message,
    turnErrorMessage(host.providerId, status),
  );
  return { snapshot, events: await host.target.eventsSince(spec, 0) };
}

test(
  "401: the rejected receipt message is the fixed attention template, with no key or upstream body",
  { timeout: 60_000 },
  async () => {
    await withHost(async (host, provider) => {
      const spec = host.specFor("reconfigure-message-401");
      await host.target.create(spec);
      provider.failWith = 401;
      const turn = await failTurn(host, spec, 401);
      assert.ok(
        provider.requests >= 1,
        "positive control: the Provider answered with the echo body",
      );

      const receipt: AgentCommandReceipt = await host.target.dispatch(spec, send(spec, "t2"));
      assert.equal(receipt.status, "rejected");
      assert.equal(receipt.reasonCode, "provider-reconfigure-required");
      assert.equal(
        receipt.message,
        `Provider ${host.providerId} credentials need attention: its last request was rejected (HTTP 401): auth_failed. Reconfigure this Provider or explicitly choose another model; no request was sent.`,
      );
      assert.deepEqual(await host.target.queryCommand(spec, "t2-command"), receipt);
      for (const [label, value] of Object.entries({ receipt, ...turn })) {
        assert.equal(
          JSON.stringify(value).includes(LEAK_MARKER),
          false,
          `${label} leaks ${LEAK_MARKER}`,
        );
      }
    });
  },
);

test(
  "403 turn path: session.error and lastError use the fixed template; the next receipt has no message",
  { timeout: 60_000 },
  async () => {
    await withHost(async (host, provider) => {
      const spec = host.specFor("reconfigure-message-403");
      await host.target.create(spec);
      provider.failWith = 403;
      const turn = await failTurn(host, spec, 403);
      assert.ok(
        provider.requests >= 1,
        "positive control: the Provider answered with the echo body",
      );
      // 403 never marks the Provider, so the next send is admitted (no receipt message at all).
      const receipt = await host.target.dispatch(spec, send(spec, "t2"));
      assert.equal(receipt.status, "accepted");
      assert.equal(receipt.message, undefined);
      await host.target.waitForIdle(spec);
      const after = await host.target.snapshot(spec);
      assert.equal(after.control.lastError?.message, turnErrorMessage(host.providerId, 403));
      for (const [label, value] of Object.entries({ receipt, after, ...turn })) {
        assert.equal(
          JSON.stringify(value).includes(LEAK_MARKER),
          false,
          `${label} leaks ${LEAK_MARKER}`,
        );
      }
    });
  },
);
