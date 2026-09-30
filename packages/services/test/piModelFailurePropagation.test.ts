import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Model } from "@zcode/contracts";
import { agentEventSchema } from "@zcode/shared/agent-host";
import { runPiModelRequest } from "../src/agent-adapters/pi/piModelRequestBridge.js";
import { createPiHostProvider } from "../src/agent-adapters/pi/piModelStream.js";

const SECRET = "sk-never-leak-123";

function failingModel(error: unknown): Model {
  return {
    providerId: "provider-a",
    modelId: "model-a",
    displayName: "Model A",
    options: { reasoningLevel: "off" },
    properties: { contextWindow: 16000 },
    optionSpecs: { maxOutputTokens: { max: 1000 } },
    // oxlint-disable-next-line require-yield -- the executor fails before its first event.
    async *streamText() {
      throw error;
    },
  } as unknown as Model;
}

/** Same shape AiSdkModelAdapter throws for a 401 (AiSdkModelAdapterError + runner context). */
function adapterAuthError(): Error {
  return Object.assign(new Error(`Provider authentication failed. ${SECRET}`), {
    name: "AiSdkModelAdapterError",
    code: "provider_not_configured",
    context: {
      reason: "auth_failed",
      statusCode: 401,
      retryable: false,
      source: "provider",
      providerId: "provider-a",
      modelId: "model-a",
      baseURL: "http://127.0.0.1:9/v1",
      requestHeaders: { authorization: `Bearer ${SECRET}` },
    },
    cause: { responseBody: `{"error":"bad key ${SECRET}"}` },
  });
}

async function runBridge(error: unknown): Promise<unknown[]> {
  const posted: unknown[] = [];
  await runPiModelRequest(
    {
      worker: { postMessage: (message: unknown) => posted.push(message) },
      model: failingModel(error),
      modelAborts: new Map(),
    } as never,
    "request-1",
    { messages: [{ role: "user", content: "hello" }], options: { reasoningLevel: "off" } },
  );
  return posted;
}

async function runHostProvider(error: unknown) {
  const provider = createPiHostProvider(failingModel(error));
  const selected = (await provider.getModels())[0]!;
  const context = normalizeContext({
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  });
  const events = [];
  for await (const event of provider.streamSimple!(selected, context)) events.push(event);
  const last = events.at(-1);
  assert.equal(last?.type, "error");
  return last?.type === "error" ? last.error : undefined;
}

const typedFailure = {
  reason: "auth_failed",
  code: "provider_not_configured",
  providerId: "provider-a",
  modelId: "model-a",
  statusCode: 401,
  retryable: false,
};

test("Pi model bridge forwards a sanitized typed 401 failure and never the key", async () => {
  const posted = await runBridge(adapterAuthError());
  assert.deepEqual(posted, [
    { type: "model.failure", requestId: "request-1", failure: typedFailure },
  ]);
  assert.equal(JSON.stringify(posted).includes(SECRET), false);
  assert.equal(JSON.stringify(posted).includes("127.0.0.1"), false);
});

test("Pi model bridge keeps the legacy reason-less failure for untyped or unsafe errors", async () => {
  assert.deepEqual(await runBridge(new Error(`boom ${SECRET}`)), [
    { type: "model.failure", requestId: "request-1" },
  ]);
  const unsafe = adapterAuthError();
  (unsafe as unknown as { context: Record<string, unknown> }).context.reason = `Bearer ${SECRET}`;
  assert.deepEqual(await runBridge(unsafe), [{ type: "model.failure", requestId: "request-1" }]);
});

test("Pi host provider keeps the typed failure as a structured assistant diagnostic", async () => {
  const error = await runHostProvider(
    Object.assign(new Error("ZCode model executor failed"), { zcodeModelFailure: typedFailure }),
  );
  assert.equal(
    error?.errorMessage,
    "ZCode model bridge failed at executor-stream; inspect target-host diagnostics",
  );
  const diagnostic = error?.diagnostics?.find(
    (candidate) => candidate.type === "zcode-model-failure",
  );
  assert.deepEqual(diagnostic?.details, typedFailure);
});

test("Pi host provider adds no diagnostic for an untyped executor error", async () => {
  const error = await runHostProvider(new Error("ZCode model executor failed"));
  assert.equal(
    error?.errorMessage,
    "ZCode model bridge failed at executor-stream; inspect target-host diagnostics",
  );
  assert.equal(
    error?.diagnostics?.some((candidate) => candidate.type === "zcode-model-failure") ?? false,
    false,
  );
});

test("session.error accepts an optional key-free reconfigure failure and stays strict", () => {
  const base = {
    hostSessionId: "host-a",
    runtimeEpoch: "epoch-a",
    sequence: 1,
    eventId: "event-a",
    at: 1,
    kind: "session.error" as const,
    code: "provider-reconfigure-required",
    message: "Provider authentication failed (HTTP 401)",
  };
  const failure = {
    reason: "auth_failed",
    action: "reconfigure-provider",
    providerId: "provider-a",
    modelId: "model-a",
    statusCode: 401,
    retryable: false,
  };
  assert.equal(agentEventSchema.safeParse(base).success, true);
  assert.deepEqual(agentEventSchema.parse({ ...base, failure }), { ...base, failure });
  assert.equal(
    agentEventSchema.safeParse({ ...base, failure: { ...failure, apiKey: SECRET } }).success,
    false,
  );
});
