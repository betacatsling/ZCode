import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import type { AgentEvent } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import {
  extractModelFailure,
  toProviderReconfigureFailure,
} from "../src/agent-host/modelFailureClassification.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";

// Pins the real Pi worker's turn-failure behaviour (session.error code, typed failure, message,
// turn outcome) so a move-only split of piWorker.ts can prove it changed nothing.
const SECRET = "sk-worker-parity-never-leak";
const identity = { providerId: "provider-a", modelId: "model-a" };

function adapterError(context: Record<string, unknown>, code: string | null): Error {
  return Object.assign(new Error(`upstream rejected ${SECRET}`), {
    name: "AiSdkModelAdapterError",
    ...(code === null ? {} : { code }),
    context: { source: "provider", baseURL: "http://127.0.0.1:9/v1", ...context },
  });
}

const CASES: Record<string, unknown> = {
  "auth-401": adapterError(
    { reason: "auth_failed", statusCode: 401, retryable: false },
    "provider_not_configured",
  ),
  "auth-403": adapterError(
    { reason: "auth_failed", statusCode: 403, retryable: false },
    "provider_not_configured",
  ),
  "not-configured": adapterError({ reason: "provider_not_configured", retryable: false }, null),
  "code-only": adapterError({ reason: "unknown", retryable: false }, "provider_not_configured"),
  "retryable-401": adapterError(
    { reason: "auth_failed", statusCode: 401, retryable: true },
    "provider_not_configured",
  ),
  "server-500": adapterError(
    { reason: "server_error", statusCode: 500, retryable: false },
    "model_request_failed",
  ),
  untyped: new Error(`boom ${SECRET}`),
};

const fakeModel = {
  ...identity,
  displayName: "Parity model",
  options: { reasoningLevel: "off" },
  properties: { contextWindow: 32000 },
  optionSpecs: { maxOutputTokens: { max: 1000 } },
  // oxlint-disable-next-line require-yield -- every case fails before its first event.
  async *streamText(request: Parameters<Model["streamText"]>[0]) {
    const last = JSON.stringify(request.messages.at(-1) ?? "");
    const key = Object.keys(CASES).find((name) => last.includes(`case:${name}`));
    throw key ? CASES[key] : new Error("unknown parity case");
  },
} as unknown as Model;

function expectedFor(error: unknown) {
  const failure = toProviderReconfigureFailure(extractModelFailure(error, identity));
  if (!failure) {
    return {
      code: "pi-model-executor-stream",
      message: "Pi model request failed; inspect target-host diagnostics",
    };
  }
  const status = failure.statusCode === undefined ? "" : ` (HTTP ${failure.statusCode})`;
  return {
    code: "provider-reconfigure-required",
    failure,
    message:
      `Provider ${failure.providerId} rejected the credentials for ${failure.modelId}${status}: ${failure.reason}. Reconfigure this Provider or explicitly choose another model; no other Provider was used.`.slice(
        0,
        1024,
      ),
  };
}

test(
  "real Pi worker: turn failures map to the shared reconfigure rule (401/403/not-configured typed; retryable/5xx/untyped generic)",
  { timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-pi-worker-parity-"));
    const worktree = join(root, "worktree");
    await mkdir(worktree);
    const registry = new HarnessRegistry();
    registry.register(
      new PiHarnessAdapter({ root: join(root, "workers"), modelFactory: () => fakeModel }),
    );
    const spec = {
      schemaVersion: 1 as const,
      hostSessionId: "pi-parity",
      execution: { targetId: "local", workspaceIdentity: "fixture", worktreePath: worktree },
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: { ...identity, options: { reasoningLevel: "off" } },
      },
    };
    const target = {
      id: "local",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux",
      available: true,
    };
    let host: SessionHost | undefined;
    try {
      host = await SessionHost.create({
        root: join(root, "journals"),
        spec,
        target,
        registry,
        catalog: { fingerprint: "fixture-v1", validateSelection: () => ({ ok: true }) },
      });
      const events: AgentEvent[] = [];
      host.subscribe((event) => events.push(event));
      for (const [index, name] of Object.keys(CASES).entries()) {
        const turnId = `turn-${index + 1}`;
        const sent = await host.dispatch({
          type: "send",
          commandId: `send-${index + 1}`,
          hostSessionId: "pi-parity",
          turnId,
          text: `case:${name}`,
        });
        assert.equal(sent.status, "accepted", name);
        await host.whenIdle();
        const turnEvents = events.filter((event) => "turnId" in event && event.turnId === turnId);
        const errors = events.filter(
          (event): event is Extract<AgentEvent, { kind: "session.error" }> =>
            event.kind === "session.error",
        );
        const error = errors.at(-1);
        assert.equal(errors.length, index + 1, `${name}: exactly one session.error per turn`);
        const {
          hostSessionId: _h,
          runtimeEpoch: _r,
          sequence: _s,
          eventId: _e,
          at: _a,
          sourceEventId: _src,
          kind,
          ...body
        } = error as unknown as Record<string, unknown>;
        assert.equal(kind, "session.error");
        const expected = expectedFor(CASES[name]);
        assert.deepEqual(body, expected, name);
        // Byte-identical wire shape, including key order of the typed failure.
        assert.equal(JSON.stringify(body.failure), JSON.stringify(expected.failure), name);
        assert.equal(JSON.stringify(body).includes(SECRET), false, `${name}: key-free`);
        assert.equal(JSON.stringify(body).includes("127.0.0.1"), false, `${name}: URL-free`);
        const finished = turnEvents.find((event) => event.kind === "turn.finished");
        assert.equal(
          (finished as { outcome?: string } | undefined)?.outcome,
          "failed",
          `${name}: turn outcome`,
        );
        assert.equal(host.queryCommand(`send-${index + 1}`)?.status, "completed", name);
      }
      // Pinned explicitly (Planner: 403 stays a turn-level typed failure; only admission is 401-only).
      const forbidden = expectedFor(CASES["auth-403"]) as { failure?: unknown };
      assert.deepEqual(forbidden.failure, {
        reason: "auth_failed",
        action: "reconfigure-provider",
        providerId: "provider-a",
        modelId: "model-a",
        statusCode: 403,
        retryable: false,
      });
      await host.dispatch({
        type: "terminateSession",
        commandId: "terminate-1",
        hostSessionId: "pi-parity",
      });
      await host.close();
      host = undefined;
    } finally {
      if (host) {
        try {
          await host.dispatch({
            type: "terminateSession",
            commandId: "cleanup",
            hostSessionId: "pi-parity",
          });
          await host.close();
        } catch {
          /* isolated test directory */
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
