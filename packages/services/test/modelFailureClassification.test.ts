import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { agentModelFailureSchema } from "@zcode/shared/agent-host";
import {
  classifyProviderReconfigureFailure,
  extractModelFailure,
  toProviderReconfigureFailure,
  type ModelFailureFacts,
} from "../src/agent-host/modelFailureClassification.js";
import { runPiModelRequest } from "../src/agent-adapters/pi/piModelRequestBridge.js";

const SECRET = "sk-never-leak-456";
const model = { providerId: "provider-a", modelId: "model-a" };

/** Same shape AiSdkModelAdapter throws (AiSdkModelAdapterError + runner context). */
function adapterError(
  context: Record<string, unknown>,
  /** null = the error carries no code (undefined would select the default). */
  code: string | null = "provider_not_configured",
): Error {
  return Object.assign(new Error(`upstream said no ${SECRET}`), {
    name: "AiSdkModelAdapterError",
    ...(code === null ? {} : { code }),
    context: {
      source: "provider",
      baseURL: "http://127.0.0.1:9/v1",
      requestHeaders: { authorization: `Bearer ${SECRET}` },
      ...context,
    },
    cause: { responseBody: `{"error":"bad key ${SECRET}"}` },
  });
}

const auth401 = () => adapterError({ reason: "auth_failed", statusCode: 401, retryable: false });

test("extractModelFailure copies only whitelisted scalars; identity comes from the Model", () => {
  const facts = extractModelFailure(auth401(), { providerId: "p-model", modelId: "m-model" });
  assert.deepEqual(facts, {
    reason: "auth_failed",
    code: "provider_not_configured",
    providerId: "p-model",
    modelId: "m-model",
    statusCode: 401,
    retryable: false,
  });
  assert.equal(JSON.stringify(facts).includes(SECRET), false);
  assert.equal(JSON.stringify(facts).includes("127.0.0.1"), false);
  // Untyped, context-less, unsafe reason/code, non-integer status.
  assert.equal(extractModelFailure(new Error(`boom ${SECRET}`), model), undefined);
  assert.equal(extractModelFailure("not an error", model), undefined);
  assert.equal(extractModelFailure(adapterError({ reason: `Bearer ${SECRET}` }), model), undefined);
  assert.deepEqual(
    extractModelFailure(
      adapterError({ reason: "server_error", statusCode: 502.5 }, "Bad Code!"),
      model,
    ),
    { reason: "server_error", providerId: "provider-a", modelId: "model-a", retryable: false },
  );
  // retryable is true only when the executor said exactly true.
  assert.equal(
    extractModelFailure(adapterError({ reason: "rate_limited", retryable: "yes" }), model)
      ?.retryable,
    false,
  );
});

test("non-retryable 401 maps to the typed reconfigure-provider failure (schema-valid, key-free)", () => {
  const failure = classifyProviderReconfigureFailure(auth401(), model);
  assert.deepEqual(failure, {
    reason: "auth_failed",
    action: "reconfigure-provider",
    providerId: "provider-a",
    modelId: "model-a",
    statusCode: 401,
    retryable: false,
  });
  assert.deepEqual(agentModelFailureSchema.parse(failure), failure);
  assert.equal(JSON.stringify(failure).includes(SECRET), false);
  // Without statusCode / without modelId the fields are omitted, never undefined.
  const bare = toProviderReconfigureFailure({
    reason: "auth_failed",
    providerId: "provider-b",
    retryable: false,
  });
  assert.deepEqual(bare, {
    reason: "auth_failed",
    action: "reconfigure-provider",
    providerId: "provider-b",
    retryable: false,
  });
  assert.equal(Object.keys(bare!).includes("modelId"), false);
  assert.equal(Object.keys(bare!).includes("statusCode"), false);
  assert.deepEqual(agentModelFailureSchema.parse(bare), bare);
});

test("provider_not_configured (reason or code) maps to reconfigure exactly as the Pi worker does", () => {
  assert.deepEqual(
    classifyProviderReconfigureFailure(
      adapterError({ reason: "provider_not_configured", retryable: false }, null),
      model,
    ),
    {
      reason: "provider_not_configured",
      action: "reconfigure-provider",
      providerId: "provider-a",
      modelId: "model-a",
      retryable: false,
    },
  );
  // Code alone qualifies (the adapter reports provider_not_configured as the code of auth errors).
  assert.deepEqual(
    classifyProviderReconfigureFailure(
      adapterError({ reason: "unknown", retryable: false }),
      model,
    ),
    {
      reason: "unknown",
      action: "reconfigure-provider",
      providerId: "provider-a",
      modelId: "model-a",
      retryable: false,
    },
  );
});

test("403 stays exactly as today: a per-turn reconfigure failure with statusCode 403", () => {
  // The Pi worker today emits provider-reconfigure-required for a non-retryable 403 auth_failed
  // (pinned end-to-end by staleProviderReconfigureNoFallback "403 keeps the typed turn failure");
  // only the Host credential-attention mark (admission) is 401-only.
  assert.deepEqual(
    classifyProviderReconfigureFailure(
      adapterError({ reason: "auth_failed", statusCode: 403, retryable: false }),
      model,
    ),
    {
      reason: "auth_failed",
      action: "reconfigure-provider",
      providerId: "provider-a",
      modelId: "model-a",
      statusCode: 403,
      retryable: false,
    },
  );
  // A 403 the adapter did not classify as an auth failure stays unclassified.
  assert.equal(
    classifyProviderReconfigureFailure(
      adapterError({ reason: "invalid_request", statusCode: 403, retryable: false }, null),
      model,
    ),
    undefined,
  );
});

test("retryable failures and other reasons never map to reconfigure", () => {
  for (const context of [
    { reason: "auth_failed", statusCode: 401, retryable: true },
    { reason: "server_error", statusCode: 500, retryable: true },
    { reason: "provider_overloaded", statusCode: 503, retryable: true },
    { reason: "rate_limited", statusCode: 429, retryable: true },
    { reason: "network_error", retryable: true },
    { reason: "provider_not_configured", retryable: true },
  ]) {
    assert.equal(classifyProviderReconfigureFailure(adapterError(context), model), undefined);
  }
  for (const context of [
    { reason: "server_error", statusCode: 500, retryable: false },
    { reason: "context_exceeded", statusCode: 400, retryable: false },
    { reason: "invalid_request", statusCode: 400, retryable: false },
  ]) {
    assert.equal(
      classifyProviderReconfigureFailure(adapterError(context, "model_request_failed"), model),
      undefined,
    );
  }
  assert.equal(classifyProviderReconfigureFailure(new Error("untyped"), model), undefined);
  assert.equal(toProviderReconfigureFailure(undefined), undefined);
});

test("identity is per Model: another Provider's error names that Provider only", () => {
  const other = { providerId: "provider-z", modelId: "model-z" };
  assert.equal(classifyProviderReconfigureFailure(auth401(), other)?.providerId, "provider-z");
  assert.equal(classifyProviderReconfigureFailure(auth401(), other)?.modelId, "model-z");
});

function failingModel(error: unknown): Model {
  return {
    ...model,
    options: {},
    properties: {},
    optionSpecs: {},
    // oxlint-disable-next-line require-yield -- the executor fails before its first event.
    async *streamText() {
      throw error;
    },
  } as unknown as Model;
}

test("the Pi model bridge forwards exactly the shared extraction (parity, not implementation)", async () => {
  const cases: unknown[] = [
    auth401(),
    adapterError({ reason: "auth_failed", statusCode: 403, retryable: false }),
    adapterError(
      { reason: "rate_limited", statusCode: 429, retryable: true },
      "model_rate_limited",
    ),
    adapterError({ reason: `Bearer ${SECRET}` }),
    new Error(`boom ${SECRET}`),
  ];
  for (const error of cases) {
    const posted: unknown[] = [];
    await runPiModelRequest(
      {
        worker: { postMessage: (message: unknown) => posted.push(message) },
        model: failingModel(error),
        modelAborts: new Map(),
      } as never,
      "request-1",
      { messages: [{ role: "user", content: "hello" }], options: {} } as never,
    );
    const facts: ModelFailureFacts | undefined = extractModelFailure(error, model);
    assert.deepEqual(posted, [
      { type: "model.failure", requestId: "request-1", ...(facts ? { failure: facts } : {}) },
    ]);
  }
});
