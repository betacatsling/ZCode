import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelRequest } from "@zcode/contracts";
import type { BindingPlan, ExecutionTarget } from "@zcode/shared/agent-host";
import {
  MODEL_GATEWAY_TOKEN_ENV,
  MODEL_GATEWAY_VERSION,
  createModelGateway,
  describeGatewayCompatibility,
  sessionResponsesProviderOverlay,
} from "../src/model-gateway/index.js";

const selection = {
  providerId: "provider-test",
  modelId: "model-test",
  options: { reasoningLevel: "off" },
};
const CREDENTIAL_REF = "provider-credential-ref";
const UPSTREAM_URL = "https://upstream.example/v1";
const UPSTREAM_KEY = "sk-upstream-secret";

function boundModel(
  reasoningLevel = "off",
  properties: Record<string, unknown> = { contextWindow: 4096 },
): Model {
  const value = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    properties,
    optionSpecs: { maxOutputTokens: { max: 128 } },
    options: { reasoningLevel },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("Fake Model test uses streaming only");
    },
    async *streamText() {
      yield { type: "start" };
      yield { type: "text_start", id: "text-1" };
      yield { type: "text_delta", id: "text-1", text: "fake response" };
      yield { type: "text_end", id: "text-1" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    },
  };
  return value as unknown as Model;
}

function plan(overrides: Record<string, unknown> = {}): BindingPlan {
  return {
    schemaVersion: 1,
    hostSessionId: "host-session-1",
    targetId: "target-test",
    harnessId: "codex",
    adapterVersion: "0.157.1",
    catalogFingerprint: "catalog-fp",
    requested: { kind: "host-managed", selection },
    effective: selection,
    route: "responses-gateway",
    credentialRef: CREDENTIAL_REF,
    support: { support: "supported" },
    capabilities: {},
    ...overrides,
  } as BindingPlan;
}

const limits = {
  maxBodyBytes: 4096,
  maxRequests: 20,
  maxConcurrent: 2,
  maxOutputTokens: 200,
  maxOutputTokensPerRequest: 100,
};

async function startedGateway(model = boundModel()) {
  const gateway = createModelGateway({ targetId: "target-test", host: "127.0.0.1", port: 0 });
  const address = await gateway.start();
  return { gateway, address, model };
}

test("createGrant admits a BindingPlan and does not keep its credential reference", async () => {
  const { gateway, model } = await startedGateway();
  try {
    const admitted = plan();
    const grant = gateway.createGrant({
      protocol: "openai-responses",
      sessionId: admitted.hostSessionId,
      modelBindingFingerprint: admitted.catalogFingerprint,
      publicModelId: "zcode-host",
      model,
      plan: admitted,
      expiresInMs: 60_000,
      limits,
    });
    assert.equal(grant.sessionId, admitted.hostSessionId);
    assert.equal(grant.modelBindingFingerprint, admitted.catalogFingerprint);
    assert.deepEqual(grant.actualModel, {
      providerId: selection.providerId,
      modelId: selection.modelId,
    });
    const serialized = JSON.stringify(grant);
    assert.equal(serialized.includes(CREDENTIAL_REF), false);
    assert.equal(serialized.includes(UPSTREAM_URL), false);
    assert.equal(serialized.includes(UPSTREAM_KEY), false);
    const overlay = sessionResponsesProviderOverlay({
      baseUrl: grant.baseUrl,
      publicModelId: grant.publicModelId,
      protocol: grant.protocol,
    });
    assert.equal(overlay.envKey, MODEL_GATEWAY_TOKEN_ENV);
    assert.match(overlay.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(overlay.wireApi, "responses");
    assert.equal(overlay.configText.includes(grant.token), false);
    assert.equal(overlay.configText.includes(CREDENTIAL_REF), false);
    assert.equal(overlay.configText.includes(UPSTREAM_URL), false);
    assert.equal(overlay.configText.includes(UPSTREAM_KEY), false);
    assert.match(overlay.configText, /env_key = "ZCODE_MODEL_GATEWAY_TOKEN"/);
  } finally {
    await gateway.close();
  }
});

test("createGrant rejects BindingPlan mismatches before issuing a token", async () => {
  const { gateway, model } = await startedGateway();
  try {
    const base = {
      protocol: "openai-responses" as const,
      sessionId: "host-session-1",
      modelBindingFingerprint: "catalog-fp",
      publicModelId: "zcode-host",
      model,
      expiresInMs: 60_000,
      limits,
    };
    assert.throws(
      () => gateway.createGrant({ ...base, plan: { schemaVersion: 1 } as BindingPlan }),
      /BindingPlan is invalid/,
    );
    assert.throws(
      () => gateway.createGrant({ ...base, sessionId: " other-host ", plan: plan() }),
      /hostSessionId/,
    );
    assert.throws(
      () => gateway.createGrant({ ...base, sessionId: "  host-session-1" }),
      /hostSessionId/,
    );
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          plan: plan({ route: "mock" }),
        }),
      /route does not match/,
    );
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          plan: plan({ route: "native" }),
        }),
      /route does not match/,
    );
    assert.throws(
      () =>
        gateway.createGrant({
          protocol: "anthropic-messages",
          sessionId: "host-session-1",
          modelBindingFingerprint: "catalog-fp",
          publicModelId: "zcode-host",
          model,
          plan: plan({ route: "pi-sdk" }),
          expiresInMs: 60_000,
          limits,
        }),
      /route does not match/,
    );
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          plan: plan({ catalogFingerprint: "other-fp" }),
        }),
      /catalog fingerprint/,
    );
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          plan: plan({
            requested: { kind: "harness-managed" },
            effective: undefined,
          }),
        }),
      /supported host-managed/,
    );
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          plan: plan({ support: { support: "unsupported", reason: "not certified" } }),
        }),
      /supported host-managed/,
    );
    const other = { ...selection, modelId: "other-model" };
    assert.throws(
      () => gateway.createGrant({ ...base, plan: plan({ effective: other }) }),
      /requested\/effective model mismatch/,
    );
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          plan: plan({
            requested: { kind: "host-managed", selection: other },
            effective: other,
          }),
        }),
      /does not match the bound Model/,
    );
    const high = {
      ...selection,
      options: { reasoningLevel: "high" },
    };
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          model: boundModel("high"),
          plan: plan({
            requested: { kind: "host-managed", selection: high },
            effective: high,
          }),
        }),
      /not admitted by the Responses slice/,
    );
    const none = { ...selection, options: { reasoningLevel: "none" } };
    assert.throws(
      () =>
        gateway.createGrant({
          ...base,
          plan: plan({
            requested: { kind: "host-managed", selection: none },
            effective: none,
          }),
        }),
      /does not match the bound Model/,
    );
  } finally {
    await gateway.close();
  }
});

test("Responses admits Pi and Claude Code host-managed routes through the bound Model", async () => {
  const { gateway } = await startedGateway();
  try {
    const admitted = [
      { route: "pi-sdk" as const, harnessId: "pi", sessionId: "host-session-pi" },
      {
        route: "messages-gateway" as const,
        harnessId: "claude-code",
        sessionId: "host-session-claude",
      },
    ];
    for (const row of admitted) {
      const grant = gateway.createGrant({
        protocol: "openai-responses",
        sessionId: row.sessionId,
        modelBindingFingerprint: "catalog-fp",
        publicModelId: "zcode-host",
        model: boundModel(),
        plan: plan({
          route: row.route,
          harnessId: row.harnessId,
          hostSessionId: row.sessionId,
        }),
        expiresInMs: 60_000,
        limits,
      });
      assert.equal(grant.protocol, "openai-responses");
    }
  } finally {
    await gateway.close();
  }
});

test("Messages grant can be admitted without issuing a Claude provider document", async () => {
  const { gateway } = await startedGateway(boundModel("high"));
  try {
    const messagesSelection = { ...selection, options: { reasoningLevel: "high" } };
    const grant = gateway.createGrant({
      protocol: "anthropic-messages",
      sessionId: "host-session-1",
      modelBindingFingerprint: "catalog-fp",
      publicModelId: "zcode-host",
      model: boundModel("high"),
      plan: plan({
        route: "messages-gateway",
        requested: { kind: "host-managed", selection: messagesSelection },
        effective: messagesSelection,
      }),
      expiresInMs: 60_000,
      limits,
    });
    assert.equal(grant.protocol, "anthropic-messages");
    assert.throws(
      () =>
        sessionResponsesProviderOverlay({
          baseUrl: grant.baseUrl,
          publicModelId: grant.publicModelId,
          protocol: grant.protocol,
        }),
      /not issued by this slice/,
    );
  } finally {
    await gateway.close();
  }
});

test("Responses overlay rejects non-loopback URLs", () => {
  assert.throws(
    () =>
      sessionResponsesProviderOverlay({
        baseUrl: UPSTREAM_URL,
        publicModelId: "zcode-host",
        protocol: "openai-responses",
      }),
    /loopback/,
  );
});

test("compatibility matrix uses shared capability reports and refuses Chat Completions", () => {
  const target: ExecutionTarget = {
    id: "local-1",
    kind: "local",
    platform: "linux",
    available: true,
  };
  const admitted = describeGatewayCompatibility({
    harnessId: "codex",
    harnessVersion: "0.157.1",
    modelSource: selection,
    target,
    route: "responses-gateway",
  });
  assert.equal(admitted.gatewayVersion, MODEL_GATEWAY_VERSION);
  assert.equal(admitted.report.support, "supported");
  assert.equal(admitted.parameters.reasoningLevel, "off");
  assert.equal(admitted.targetPlatform, "linux");
  assert.equal(admitted.modelSource.providerId, selection.providerId);
  const chat = describeGatewayCompatibility({
    harnessId: "codex",
    harnessVersion: "0.157.1",
    modelSource: selection,
    target,
    route: "chat-completions",
  });
  assert.equal(chat.report.support, "unsupported");
  assert.match(chat.report.reason ?? "", /Chat Completions/);
  const messages = describeGatewayCompatibility({
    harnessId: "claude-code",
    harnessVersion: "1.0.0",
    modelSource: { ...selection, options: { reasoningLevel: "high" } },
    target,
    route: "messages-gateway",
  });
  assert.equal(messages.report.support, "experimental");
  assert.match(messages.report.reason ?? "", /does not certify a live Provider/);
  const pi = describeGatewayCompatibility({
    harnessId: "pi",
    harnessVersion: "0.87.1",
    modelSource: selection,
    target: { ...target, platform: "darwin" },
    route: "pi-sdk",
  });
  assert.equal(pi.report.support, "supported");
  assert.equal(pi.targetPlatform, "darwin");
  const native = describeGatewayCompatibility({
    harnessId: "zcode",
    harnessVersion: "1.0.0",
    modelSource: selection,
    target,
    route: "native",
  });
  assert.equal(native.report.support, "unsupported");
  assert.match(native.report.reason ?? "", /not served/);
  const remote = describeGatewayCompatibility({
    harnessId: "codex",
    harnessVersion: "0.157.1",
    modelSource: selection,
    target: { ...target, kind: "ssh" },
    route: "responses-gateway",
  });
  assert.equal(remote.report.support, "experimental");
  assert.match(remote.report.reason ?? "", /remote credential/);
  const reasoned = describeGatewayCompatibility({
    harnessId: "codex",
    harnessVersion: "0.157.1",
    modelSource: { ...selection, options: { reasoningLevel: "high" } },
    target,
    route: "responses-gateway",
  });
  assert.equal(reasoned.report.support, "unsupported");
});

function responsesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_metadata: { session_id: "codex-session-1", thread_id: "codex-thread-1" },
    include: ["reasoning.encrypted_content"],
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
    instructions: "system layer",
    model: "zcode-host",
    parallel_tool_calls: true,
    prompt_cache_key: "fixture-cache-key",
    reasoning: { effort: "none" },
    store: false,
    stream: true,
    tool_choice: "auto",
    tools: [],
    ...overrides,
  };
}

test("Responses routing uses the fake executor and rejects Chat Completions and context overflow", async (t) => {
  const seen: ModelRequest[] = [];
  let calls = 0;
  const model = boundModel();
  const original = model.streamText.bind(model);
  model.streamText = (request: ModelRequest) => {
    calls += 1;
    seen.push(request);
    return original(request);
  };
  const gateway = createModelGateway({ targetId: "target-test", host: "127.0.0.1", port: 0 });
  const { baseUrl } = await gateway.start();
  const grant = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: "host-session-1",
    modelBindingFingerprint: "catalog-fp",
    publicModelId: "zcode-host",
    model,
    plan: plan(),
    expiresInMs: 60_000,
    limits,
  });
  t.after(() => gateway.close());
  const post = (url: string, token = grant.token, body: unknown = responsesBody()) =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const chat = await post(`${baseUrl}/v1/chat/completions`);
  assert.equal(chat.status, 404);
  const anonymousChat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(anonymousChat.status, 404);
  const overflowModel = boundModel("off", { contextWindow: 32, supportsToolCall: true });
  const overflowGateway = createModelGateway({
    targetId: "target-overflow",
    host: "127.0.0.1",
    port: 0,
  });
  const overflowAddress = await overflowGateway.start();
  const overflowGrant = overflowGateway.createGrant({
    protocol: "openai-responses",
    sessionId: "host-overflow",
    modelBindingFingerprint: "catalog-fp",
    publicModelId: "zcode-host",
    model: overflowModel,
    expiresInMs: 60_000,
    limits,
  });
  t.after(() => overflowGateway.close());
  const overflow = await fetch(`${overflowAddress.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${overflowGrant.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(responsesBody({ max_output_tokens: 64 })),
  });
  assert.equal(overflow.status, 400);
  assert.equal(
    ((await overflow.json()) as { error: { code: string } }).error.code,
    "unsupported_feature",
  );
  const toolModel = boundModel("off", { contextWindow: 4096, supportsToolCall: false });
  const toolGateway = createModelGateway({ targetId: "target-tools", host: "127.0.0.1", port: 0 });
  const toolAddress = await toolGateway.start();
  const toolGrant = toolGateway.createGrant({
    protocol: "openai-responses",
    sessionId: "host-tools",
    modelBindingFingerprint: "catalog-fp",
    publicModelId: "zcode-host",
    model: toolModel,
    expiresInMs: 60_000,
    limits,
  });
  t.after(() => toolGateway.close());
  const tools = await fetch(`${toolAddress.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${toolGrant.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      responsesBody({
        tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      }),
    ),
  });
  assert.equal(tools.status, 400);
  assert.equal(
    ((await tools.json()) as { error: { code: string } }).error.code,
    "unsupported_feature",
  );
  const ok = await post(`${baseUrl}/v1/responses`);
  assert.equal(ok.status, 200);
  const payload = await ok.text();
  assert.match(payload, /response\.completed/);
  assert.equal(calls, 1);
  const request = seen[0];
  assert.ok(request);
  assert.equal(request.systemInstructions, "system layer");
  assert.equal(request.messages[0]?.role, "developer");
  assert.equal(JSON.stringify(request).includes("fixture-cache-key"), false);
  assert.equal(JSON.stringify(request).includes(grant.token), false);
  assert.equal(JSON.stringify(request).includes(UPSTREAM_URL), false);
  assert.equal(JSON.stringify(request).includes(UPSTREAM_KEY), false);
  assert.equal(calls, 1);
});
