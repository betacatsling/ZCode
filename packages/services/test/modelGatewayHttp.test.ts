import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { Model, ModelRequest } from "@zcode/contracts";
import { GatewayApplication } from "../src/model-gateway/app/gatewayApplication.js";
import { nodeGatewayTokens } from "../src/model-gateway/adapters/nodeGatewayTokens.js";
import { createModelGateway } from "../src/model-gateway/index.js";

type FakeBehavior = (request: ModelRequest) => AsyncIterable<{
  type: string;
  [key: string]: unknown;
}>;

function model(behavior?: FakeBehavior, onStart?: () => void, onAbort?: () => void): Model {
  const defaultBehavior: FakeBehavior = async function* () {
    yield { type: "start" };
    yield { type: "text_start", id: "text-1" };
    yield { type: "text_delta", id: "text-1", text: "fake response" };
    yield { type: "text_end", id: "text-1" };
    yield {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    };
  };
  const value = {
    providerId: "provider-test",
    modelId: "model-test",
    displayName: "Fake",
    properties: { contextWindow: 4096 },
    optionSpecs: { maxOutputTokens: { max: 64 } },
    options: { reasoningLevel: "off" },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("Fake Model test uses streaming only");
    },
    async *streamText(request: ModelRequest) {
      onStart?.();
      try {
        for await (const event of (behavior ?? defaultBehavior)(request)) yield event;
      } finally {
        if (request.abortSignal?.aborted) onAbort?.();
      }
    },
  };
  return value as unknown as Model;
}

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_metadata: { session_id: "codex-session-1", thread_id: "codex-thread-1" },
    include: ["reasoning.encrypted_content"],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    instructions: "test instruction",
    model: "fixture-model",
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

async function gatewayFixture(
  t: test.TestContext,
  boundModel: Model,
  limits = {
    maxBodyBytes: 4096,
    maxRequests: 20,
    maxConcurrent: 2,
    maxOutputTokens: 20,
    maxOutputTokensPerRequest: 8,
  },
) {
  const gateway = createModelGateway({
    targetId: "target-test",
    host: "127.0.0.1",
    port: 0,
    maxConcurrent: 4,
  });
  const { baseUrl } = await gateway.start();
  const grant = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: "session-test",
    modelBindingFingerprint: "binding-fingerprint-test",
    publicModelId: "fixture-model",
    model: boundModel,
    expiresInMs: 60_000,
    limits,
  });
  t.after(() => gateway.close());
  const post = (
    body: unknown,
    token = grant.token,
    url = baseUrl + "/v1/responses",
    signal?: AbortSignal,
  ) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal,
    });
  return { gateway, grant, baseUrl, post };
}

async function events(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((record) => JSON.parse(record.slice(record.indexOf("data: ") + 6)));
}

test("HTTP Gateway isolates grants and rejects unknown routes or invalid requests before model execution", async (t) => {
  let calls = 0;
  const fixture = await gatewayFixture(
    t,
    model(undefined, () => calls++),
  );
  const noAuth = await fetch(fixture.baseUrl + "/v1/responses", { method: "POST", body: "{}" });
  assert.equal(noAuth.status, 401);
  assert.equal(((await noAuth.json()) as { error: { code: string } }).error.code, "unauthorized");
  const route = await fixture.post(
    requestBody(),
    fixture.grant.token,
    fixture.baseUrl + "/v1/models",
  );
  assert.equal(route.status, 404);
  const method = await fetch(fixture.baseUrl + "/v1/responses", { method: "GET" });
  assert.equal(method.status, 405);
  const wrongModel = await fixture.post(requestBody({ model: "other-model" }));
  assert.equal(wrongModel.status, 400);
  const wrongModelBody = await wrongModel.text();
  assert.equal(wrongModelBody.includes(fixture.grant.token), false);
  const serialTools = await fixture.post(requestBody({ parallel_tool_calls: false }));
  assert.equal(serialTools.status, 400);
  assert.equal(
    ((await serialTools.json()) as { error: { code: string } }).error.code,
    "unsupported_feature",
  );
  const unsupported = await fixture.post(
    requestBody({
      input: [
        { type: "message", role: "user", content: [{ type: "input_image", image_url: "x" }] },
      ],
    }),
  );
  assert.equal(unsupported.status, 400);
  assert.equal(
    ((await unsupported.json()) as { error: { code: string } }).error.code,
    "unsupported_feature",
  );
  assert.equal(calls, 0);
});

test("HTTP Gateway binds one bearer grant to its first Codex session and thread", async (t) => {
  const fixture = await gatewayFixture(t, model());
  assert.equal(fixture.grant.sessionId, "session-test");
  assert.equal(fixture.grant.modelBindingFingerprint, "binding-fingerprint-test");
  assert.deepEqual(fixture.grant.actualModel, {
    providerId: "provider-test",
    modelId: "model-test",
  });
  const first = await fixture.post(requestBody());
  assert.equal(first.status, 200);
  await first.text();
  const otherThread = await fixture.post(
    requestBody({
      client_metadata: { session_id: "codex-session-1", thread_id: "codex-thread-2" },
    }),
  );
  assert.equal(otherThread.status, 401);
  assert.equal(
    ((await otherThread.json()) as { error: { code: string } }).error.code,
    "unauthorized",
  );
  fixture.gateway.revoke(fixture.grant.id);
  const revoked = await fixture.post(requestBody());
  assert.equal(revoked.status, 401);
});

test("HTTP Gateway enforces request count, output reservation, and body limits", async (t) => {
  let calls = 0;
  const fixture = await gatewayFixture(
    t,
    model(undefined, () => calls++),
    {
      maxBodyBytes: 512,
      maxRequests: 20,
      maxConcurrent: 1,
      maxOutputTokens: 5,
      maxOutputTokensPerRequest: 3,
    },
  );
  const overLimit = await fixture.post(requestBody({ max_output_tokens: 4 }));
  assert.equal(overLimit.status, 429);
  assert.equal(
    ((await overLimit.json()) as { error: { code: string } }).error.code,
    "budget_exceeded",
  );
  const tooLarge = await fixture.post("x".repeat(600));
  assert.equal(tooLarge.status, 413);
  assert.equal(calls, 0);
  const accepted1 = await fixture.post(requestBody());
  assert.equal(accepted1.status, 200);
  const responseEvents = await events(accepted1);
  const completed1 = responseEvents.find((event) => event.type === "response.completed");
  assert.ok(completed1);
  assert.deepEqual((completed1.response as { usage: unknown }).usage, {
    input_tokens: 4,
    output_tokens: 2,
    total_tokens: 6,
  });
  const accepted2 = await fixture.post(requestBody({ max_output_tokens: 3 }));
  assert.equal(accepted2.status, 200);
  await accepted2.text();
  const modelOverrun = await fixture.post(requestBody());
  assert.equal(modelOverrun.status, 200);
  const overrunEvents = await events(modelOverrun);
  assert.equal(
    overrunEvents.some((event) => event.type === "response.completed"),
    false,
  );
  const overrunError = overrunEvents.find((event) => event.type === "error");
  assert.ok(overrunError);
  assert.equal((overrunError.error as { code: string }).code, "budget_exceeded");
  const exhausted = await fixture.post(requestBody());
  assert.equal(exhausted.status, 429);
  assert.equal(
    ((await exhausted.json()) as { error: { code: string } }).error.code,
    "budget_exceeded",
  );
  assert.equal(calls, 3);
});

test("HTTP Gateway consumes the per-grant request budget once a valid request is admitted", async (t) => {
  let calls = 0;
  const fixture = await gatewayFixture(
    t,
    model(undefined, () => calls++),
    {
      maxBodyBytes: 4096,
      maxRequests: 1,
      maxConcurrent: 1,
      maxOutputTokens: 20,
      maxOutputTokensPerRequest: 8,
    },
  );
  const first = await fixture.post(requestBody());
  assert.equal(first.status, 200);
  await first.text();
  const second = await fixture.post(requestBody());
  assert.equal(second.status, 429);
  assert.equal(
    ((await second.json()) as { error: { code: string } }).error.code,
    "budget_exceeded",
  );
  assert.equal(calls, 1);
});

test("HTTP disconnect aborts the bound Model stream and releases concurrency", async (t) => {
  let startedResolve: (() => void) | undefined;
  let abortedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abortedResolve = resolve;
  });
  const behavior: FakeBehavior = async function* (request) {
    yield { type: "start" };
    startedResolve?.();
    if (!request.abortSignal?.aborted) {
      await new Promise<void>((resolve) =>
        request.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
  };
  const fixture = await gatewayFixture(
    t,
    model(behavior, undefined, () => abortedResolve?.()),
    {
      maxBodyBytes: 4096,
      maxRequests: 20,
      maxConcurrent: 1,
      maxOutputTokens: 20,
      maxOutputTokensPerRequest: 8,
    },
  );
  const controller = new AbortController();
  const response = await fixture.post(
    requestBody(),
    fixture.grant.token,
    undefined,
    controller.signal,
  );
  const reader = response.body?.getReader();
  await started;
  const blocked = await fixture.post(requestBody());
  assert.equal(blocked.status, 429);
  controller.abort();
  await reader?.cancel().catch(() => undefined);
  await aborted;
});

test("HTTP Gateway expiry and revocation block later requests", async (t) => {
  const gateway = createModelGateway({ targetId: "target-expiry", host: "127.0.0.1", port: 0 });
  const { baseUrl } = await gateway.start();
  const grant = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: "session-expiry",
    modelBindingFingerprint: "binding-expiry",
    publicModelId: "fixture-model",
    model: model(),
    expiresInMs: 15,
    limits: {
      maxBodyBytes: 4096,
      maxRequests: 10,
      maxConcurrent: 1,
      maxOutputTokens: 10,
      maxOutputTokensPerRequest: 5,
    },
  });
  t.after(() => gateway.close());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const renewed = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: "session-expiry",
    modelBindingFingerprint: "binding-renewed",
    publicModelId: "fixture-model",
    model: model(),
    expiresInMs: 60_000,
    limits: {
      maxBodyBytes: 4096,
      maxRequests: 10,
      maxConcurrent: 1,
      maxOutputTokens: 10,
      maxOutputTokensPerRequest: 5,
    },
  });
  assert.notEqual(renewed.token, grant.token);
  const expired = await fetch(baseUrl + "/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + grant.token },
    body: JSON.stringify(requestBody()),
  });
  assert.equal(expired.status, 401);
  const fresh = await fetch(baseUrl + "/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + renewed.token, "content-type": "application/json" },
    body: JSON.stringify(requestBody()),
  });
  assert.equal(fresh.status, 200);
  await fresh.text();
});

test("injected Gateway clock rejects an expired session grant and permits explicit rebind", async () => {
  let now = 10_000;
  let calls = 0;
  const boundModel = model(undefined, () => calls++);
  const application = new GatewayApplication(
    { targetId: "target-clock", host: "127.0.0.1", port: 0 },
    nodeGatewayTokens,
    () => now,
  );
  application.setBaseUrl("http://127.0.0.1:12345");
  const limits = {
    maxBodyBytes: 4096,
    maxRequests: 20,
    maxConcurrent: 2,
    maxOutputTokens: 20,
    maxOutputTokensPerRequest: 8,
  };
  const grant = application.createGrant({
    protocol: "openai-responses",
    sessionId: "session-clock",
    modelBindingFingerprint: "catalog-v1",
    publicModelId: "fixture-model",
    model: boundModel,
    expiresInMs: 1_000,
    limits,
  });
  now = grant.expiresAt + 1;
  const rawBody = new TextEncoder().encode(JSON.stringify(requestBody()));
  const expired = await application.handle({
    method: "POST",
    path: "/v1/responses",
    authorization: `Bearer ${grant.token}`,
    contentLength: String(rawBody.byteLength),
    body: Readable.from([rawBody]),
    signal: new AbortController().signal,
  });
  assert.equal(expired.status, 401);
  assert.equal(calls, 0);

  const rebound = application.createGrant({
    protocol: "openai-responses",
    sessionId: "session-clock",
    modelBindingFingerprint: "catalog-v2",
    publicModelId: "fixture-model",
    model: boundModel,
    expiresInMs: 1_000,
    limits,
  });
  assert.notEqual(rebound.token, grant.token);
  assert.equal(rebound.modelBindingFingerprint, "catalog-v2");
  assert.equal(rebound.actualModel.modelId, boundModel.modelId);
  application.close();
});

test("same-binding grant and active turn lease renew without widening an expired token", async () => {
  let now = 1_000;
  let calls = 0;
  const boundModel = model(undefined, () => calls++);
  const application = new GatewayApplication(
    {
      targetId: "target-turn-lease",
      host: "127.0.0.1",
      port: 0,
      maxGrantLifetimeMs: 100,
      maxTurnLeaseMs: 60,
    },
    nodeGatewayTokens,
    () => now,
  );
  application.setBaseUrl("http://127.0.0.1:12345");
  const limits = {
    maxBodyBytes: 4096,
    maxRequests: 20,
    maxConcurrent: 2,
    maxOutputTokens: 20,
    maxOutputTokensPerRequest: 8,
  };
  const grant = application.createGrant({
    protocol: "openai-responses",
    sessionId: "session-turn-lease",
    modelBindingFingerprint: "catalog-v1",
    publicModelId: "fixture-model",
    model: boundModel,
    expiresInMs: 50,
    limits,
  });
  const firstLease = application.beginTurnLease(grant.id, "host-turn-1");
  assert.throws(
    () =>
      application.renewGrant(grant.id, {
        expectedModelBindingFingerprint: "catalog-v2",
        expiresInMs: 50,
      }),
    /cannot change its binding/,
  );

  const rawBody = new TextEncoder().encode(JSON.stringify(requestBody()));
  const request = () =>
    application.handle({
      method: "POST",
      path: "/v1/responses",
      authorization: `Bearer ${grant.token}`,
      contentLength: String(rawBody.byteLength),
      body: Readable.from([rawBody]),
      signal: new AbortController().signal,
    });

  now = grant.expiresAt + 1;
  const duringTool = await request();
  assert.equal(duringTool.status, 200);
  for await (const _chunk of duringTool.body as AsyncIterable<Uint8Array>) {
    // Drain the generated response without waiting for a real grant lifetime.
  }
  assert.equal(calls, 1);

  now = firstLease.expiresAt + 1;
  const renewedLease = application.renewTurnLease(grant.id, "host-turn-1");
  assert.ok(renewedLease.expiresAt > now);
  const afterTool = await request();
  assert.equal(afterTool.status, 200);
  for await (const _chunk of afterTool.body as AsyncIterable<Uint8Array>) {
    // Drain the generated response without waiting for a real grant lifetime.
  }
  assert.equal(calls, 2);

  application.endTurnLease(grant.id, "host-turn-1");
  now = renewedLease.expiresAt + 1;
  assert.equal((await request()).status, 401);
  assert.equal(calls, 2);

  const renewedGrant = application.renewGrant(grant.id, {
    expectedModelBindingFingerprint: "catalog-v1",
    expiresInMs: 50,
  });
  assert.ok(renewedGrant.expiresAt > now);
  const sameTokenRequest = await request();
  assert.equal(sameTokenRequest.status, 200);
  for await (const _chunk of sameTokenRequest.body as AsyncIterable<Uint8Array>) {
    // Drain the generated response without waiting for a real grant lifetime.
  }
  assert.equal(calls, 3);

  application.revoke(grant.id);
  assert.throws(
    () =>
      application.renewGrant(grant.id, {
        expectedModelBindingFingerprint: "catalog-v1",
        expiresInMs: 50,
      }),
    /missing or revoked/,
  );
  const nextBinding = application.createGrant({
    protocol: "openai-responses",
    sessionId: "session-turn-lease",
    modelBindingFingerprint: "catalog-v2",
    publicModelId: "fixture-model-v2",
    model: boundModel,
    expiresInMs: 50,
    limits,
  });
  assert.notEqual(nextBinding.token, grant.token);
  const newAliasBody = new TextEncoder().encode(
    JSON.stringify(requestBody({ model: "fixture-model-v2" })),
  );
  const oldTokenOnNewBinding = await application.handle({
    method: "POST",
    path: "/v1/responses",
    authorization: `Bearer ${grant.token}`,
    contentLength: String(newAliasBody.byteLength),
    body: Readable.from([newAliasBody]),
    signal: new AbortController().signal,
  });
  assert.equal(oldTokenOnNewBinding.status, 401);
  assert.equal(calls, 3);
  application.close();
});

test("revoking an active grant aborts its model request", async (t) => {
  let startedResolve: (() => void) | undefined;
  let abortedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abortedResolve = resolve;
  });
  const behavior: FakeBehavior = async function* (request) {
    yield { type: "start" };
    startedResolve?.();
    if (!request.abortSignal?.aborted) {
      await new Promise<void>((resolve) =>
        request.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
  };
  const fixture = await gatewayFixture(
    t,
    model(behavior, undefined, () => abortedResolve?.()),
  );
  const response = await fixture.post(requestBody());
  const reader = response.body?.getReader();
  await started;
  fixture.gateway.revoke(fixture.grant.id);
  await aborted;
  await reader?.cancel().catch(() => undefined);
});
