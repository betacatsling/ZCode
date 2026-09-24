import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import type { Model, ModelEvent } from "@zcode/contracts";
import { createModelGateway } from "../src/model-gateway/gateway.js";
import type { GatewayProtocolAdapter, GatewayTokenBinding } from "../src/model-gateway/contract.js";

const binding = (overrides: Partial<GatewayTokenBinding> = {}): GatewayTokenBinding => ({
  targetId: "target",
  hostSessionId: "session",
  runtimeEpoch: "epoch-1",
  turnId: "turn-1",
  protocol: "responses",
  requestedModelAlias: "local-model",
  effectiveSelection: {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "high" },
  },
  expiresAt: Date.now() + 60_000,
  maxRequests: 2,
  maxOutputBytes: 2000,
  maxGenerationTokens: 200,
  maxOutputTokensPerRequest: 100,
  ...overrides,
});
const codec: GatewayProtocolAdapter = {
  id: "responses",
  paths: ["/v1/responses"],
  decode(body) {
    if (
      !body ||
      typeof body !== "object" ||
      !("model" in body) ||
      !("stream" in body) ||
      body.stream !== true ||
      typeof body.model !== "string"
    ) {
      throw Object.assign(new Error("invalid"), { statusCode: 422, code: "invalid_request" });
    }
    return {
      modelId: body.model,
      stream: true,
      request: {
        messages: [{ role: "user", content: "hi" }],
        options:
          "options" in body
            ? (body.options as { maxOutputTokens?: number; reasoningLevel?: string })
            : undefined,
      },
    };
  },
  async *encode(events) {
    for await (const event of events) yield { event: "message", data: event };
  },
};
function model(stream: (signal: AbortSignal | undefined) => AsyncIterable<ModelEvent>): Model {
  return {
    options: { reasoningLevel: "high" },
    providerId: "provider-a",
    modelId: "model-a",
    streamText: (request) => stream(request.abortSignal),
  } as Model;
}
const simple = model(async function* () {
  yield { type: "start" };
  yield { type: "text_delta", text: "hello" };
});
const post = (
  url: string,
  token: string,
  body: unknown = { model: "local-model", stream: true },
  path = "/v1/responses",
) =>
  fetch(url + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function fixture(
  options: {
    model?: Model;
    maxBodyBytes?: number;
    maxConcurrentRequests?: number;
    protocols?: GatewayProtocolAdapter[];
    resolveModel?: () => Model;
  } = {},
) {
  const gateway = createModelGateway({
    protocols: options.protocols ?? [codec],
    resolveModel: options.resolveModel ?? (() => options.model ?? simple),
    limits: {
      maxBodyBytes: options.maxBodyBytes ?? 256,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 1,
    },
  });
  const address = await gateway.start();
  return { gateway, url: address.url, token: await gateway.issueToken(binding()) };
}

test("local HTTP route uses the injected Model and codec, never a client-selected provider", async () => {
  let seen = 0;
  const f = await fixture({
    resolveModel: () => {
      seen++;
      return simple;
    },
  });
  try {
    const response = await post(f.url, f.token);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /hello/);
    assert.equal(seen, 1);
    for (const [path, body] of [
      ["/v1/unknown", { model: "local-model", stream: true }],
      ["/v1/responses", { model: "wrong", stream: true }],
      ["/v1/responses", { model: "local-model", stream: false }],
    ] as const) {
      assert.notEqual((await post(f.url, f.token, body, path)).status, 200);
    }
    assert.equal((await post(f.url, "invalid")).status, 401);
    assert.equal((await post(f.url + "?upstream=https://example.org", f.token)).status, 404);
    assert.equal(seen, 1);
  } finally {
    await f.gateway.close();
  }
  await assert.rejects(fetch(f.url));
});

test("a token cannot cross a registered protocol path", async () => {
  const messages: GatewayProtocolAdapter = {
    ...codec,
    id: "anthropic-messages",
    paths: ["/v1/messages"],
  };
  const gateway = createModelGateway({
    protocols: [codec, messages],
    resolveModel: () => simple,
    limits: { maxBodyBytes: 256, maxConcurrentRequests: 1 },
  });
  const { url } = await gateway.start();
  try {
    const token = await gateway.issueToken(binding());
    assert.equal((await post(url, token, undefined, "/v1/messages")).status, 403);
    const other = await gateway.issueToken(binding({ protocol: "anthropic-messages" }));
    assert.equal((await post(url, other)).status, 403);
    assert.equal((await post(url, other, undefined, "/v1/messages")).status, 200);
  } finally {
    await gateway.close();
  }
});

test("body, request count, expired/revoked epoch bindings and resolver identity fail closed", async () => {
  const f = await fixture({ maxBodyBytes: 60 });
  try {
    assert.equal(
      (await post(f.url, f.token, { model: "local-model", stream: true, padding: "x".repeat(100) }))
        .status,
      413,
    );
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        f.url + "/v1/responses",
        {
          method: "POST",
          headers: { authorization: `Bearer ${f.token}`, "transfer-encoding": "chunked" },
        },
        (response) => {
          resolve(response.statusCode ?? 0);
          response.resume();
        },
      );
      outgoing.on("error", reject);
      outgoing.write("x".repeat(100));
      outgoing.end();
    });
    assert.equal(chunkedStatus, 413);
    const expired = await f.gateway.issueToken(
      binding({ expiresAt: Date.now() + 20, runtimeEpoch: "old" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal((await post(f.url, expired)).status, 401);
    const stale = await f.gateway.issueToken(binding({ runtimeEpoch: "old" }));
    f.gateway.revokeToken(stale);
    assert.equal((await post(f.url, stale)).status, 401);
    const once = await f.gateway.issueToken(binding({ maxRequests: 1 }));
    assert.equal((await post(f.url, once)).status, 200);
    assert.equal((await post(f.url, once)).status, 429);
  } finally {
    await f.gateway.close();
  }
  const wrong = createModelGateway({
    protocols: [codec],
    resolveModel: () => ({ ...simple, modelId: "other" }),
    limits: { maxBodyBytes: 256, maxConcurrentRequests: 1 },
  });
  await wrong.start();
  try {
    await assert.rejects(wrong.issueToken(binding()), { code: "model_identity_mismatch" });
  } finally {
    await wrong.close();
  }
});

test("concurrency, revocation and client disconnect abort an active model stream", async () => {
  const signals: AbortSignal[] = [];
  const wait = model(async function* (signal) {
    if (!signal) throw new Error("missing abort signal");
    signals.push(signal);
    yield { type: "start" };
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const f = await fixture({ model: wait });
  try {
    const first = await post(f.url, f.token);
    assert.equal(first.status, 200);
    assert.equal((await post(f.url, f.token)).status, 429);
    f.gateway.revokeToken(f.token);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(signals[0]?.aborted, true);
    assert.equal((await post(f.url, f.token)).status, 401);
    await first.body?.cancel().catch(() => {});
    const next = await f.gateway.issueToken(binding());
    const controller = new AbortController();
    const response = await fetch(f.url + "/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${next}` },
      body: JSON.stringify({ model: "local-model", stream: true }),
    });
    assert.equal(response.status, 200);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(signals[1]?.aborted, true);
  } finally {
    await f.gateway.close();
  }
});

test("active token expiry aborts the running model, not just later requests", async () => {
  let signal: AbortSignal | undefined;
  const stream = model(async function* (abortSignal) {
    signal = abortSignal;
    yield { type: "start" };
    await new Promise<void>((resolve) =>
      abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const f = await fixture({ model: stream });
  try {
    const short = await f.gateway.issueToken(binding({ expiresAt: Date.now() + 80 }));
    const response = await post(f.url, short);
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 110));
    assert.equal(signal?.aborted, true);
    assert.equal((await post(f.url, short)).status, 401);
  } finally {
    await f.gateway.close();
  }
});

test("closing aborts active streams, removes listener, and prevents new admission", async () => {
  let signal: AbortSignal | undefined;
  const stream = model(async function* (abortSignal) {
    signal = abortSignal;
    yield { type: "start" };
    await new Promise<void>((resolve) =>
      abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const f = await fixture({ model: stream });
  const response = await post(f.url, f.token);
  assert.equal(response.status, 200);
  await f.gateway.close();
  assert.equal(signal?.aborted, true);
  await assert.rejects(f.gateway.issueToken(binding()));
  await assert.rejects(fetch(f.url));
});

test("stream errors are redacted terminal SSE; aggregate output budget bounds writes", async () => {
  const broken = model(async function* () {
    yield { type: "start" };
    throw new Error("private upstream URL");
  });
  const f = await fixture({ model: broken });
  try {
    const text = await (await post(f.url, f.token)).text();
    assert.match(text, /event: error/);
    assert.doesNotMatch(text, /private upstream URL/);
    const limited = await fixture({
      model: model(async function* () {
        yield { type: "start" };
        yield { type: "text_delta", text: "x".repeat(1000) };
      }),
    });
    try {
      const short = await limited.gateway.issueToken(binding({ maxOutputBytes: 120 }));
      const output = await (await post(limited.url, short)).text();
      assert.ok(Buffer.byteLength(output) <= 120);
      assert.match(output, /event: error/);
    } finally {
      await limited.gateway.close();
    }
  } finally {
    await f.gateway.close();
  }
});

test("concurrent delayed chunked bodies reserve request admission before await; malformed bodies spend budget", async () => {
  let calls = 0;
  const f = await fixture({
    maxConcurrentRequests: 2,
    resolveModel: () =>
      model(async function* () {
        calls++;
        yield { type: "start" };
      }),
  });
  const token = await f.gateway.issueToken(binding({ maxRequests: 1 }));
  try {
    const pending = request(f.url + "/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "transfer-encoding": "chunked" },
    });
    pending.on("error", () => {});
    pending.write('{"model":');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await post(f.url, token)).status, 429);
    const first = new Promise<number>((resolve, reject) => {
      pending.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      pending.on("error", reject);
    });
    pending.end('"local-model","stream":true}');
    assert.equal(await first, 200);
    assert.equal(calls, 1);
    const malformed = await f.gateway.issueToken(binding({ maxRequests: 1 }));
    assert.equal((await post(f.url, malformed, { garbage: true })).status, 422);
    assert.equal((await post(f.url, malformed)).status, 429);
  } finally {
    await f.gateway.close();
  }
});

test("prepared model remains fixed across resolver drift; options and aggregate token allowance are enforced", async () => {
  const requests: { maxOutputTokens?: number; reasoningLevel?: string }[] = [];
  let resolves = 0;
  const prepared = model(async function* () {
    yield { type: "start" };
  });
  prepared.streamText = (input) => {
    requests.push(input.options ?? {});
    return (async function* () {
      yield { type: "start" } as ModelEvent;
    })();
  };
  const f = await fixture({
    maxConcurrentRequests: 2,
    resolveModel: () => {
      resolves++;
      return resolves <= 2 ? prepared : { ...prepared, modelId: "drift" };
    },
  });
  try {
    assert.equal(resolves, 1);
    assert.equal(
      (
        await post(f.url, f.token, {
          model: "local-model",
          stream: true,
          options: { maxOutputTokens: 101 },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await post(f.url, f.token, {
          model: "local-model",
          stream: true,
          options: { reasoningLevel: "low" },
        })
      ).status,
      422,
    );
    const allowed = await f.gateway.issueToken(
      binding({ maxRequests: 4, maxGenerationTokens: 130, maxOutputTokensPerRequest: 100 }),
    );
    prepared.streamText = () => {
      throw new Error("drifted model executor");
    };
    assert.equal((await post(f.url, allowed)).status, 200);
    assert.deepEqual(requests.at(-1), { reasoningLevel: "high", maxOutputTokens: 100 });
    assert.equal(
      (
        await post(f.url, allowed, {
          model: "local-model",
          stream: true,
          options: { maxOutputTokens: 31 },
        })
      ).status,
      429,
    );
    assert.equal((await post(f.url, allowed)).status, 200);
    assert.equal(requests.at(-1)?.maxOutputTokens, 30);
    assert.equal(resolves, 2);
    assert.equal((await post(f.url, allowed)).status, 429);
    await assert.rejects(f.gateway.issueToken(binding()), { code: "model_identity_mismatch" });
  } finally {
    await f.gateway.close();
  }
});

test("query allowlist matches raw pathname and exactly one declared beta value", async () => {
  let seenBeta: string | undefined;
  const messages: GatewayProtocolAdapter = {
    ...codec,
    id: "anthropic-messages",
    paths: ["/v1/messages"],
    allowedQueryParameters: { beta: ["true"] },
    decode(body, headers) {
      seenBeta = headers["anthropic-beta"];
      return codec.decode(body, headers);
    },
  };
  const f = await fixture({ protocols: [codec, messages] });
  try {
    const token = await f.gateway.issueToken(
      binding({ protocol: "anthropic-messages", maxRequests: 10 }),
    );
    assert.equal(
      (
        await fetch(f.url + "/v1/messages?beta=true", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "anthropic-beta": "test-2026-01-01" },
          body: JSON.stringify({ model: "local-model", stream: true }),
        })
      ).status,
      200,
    );
    assert.equal(seenBeta, "test-2026-01-01");
    assert.equal(
      (
        await fetch(f.url + "/v1/messages?beta=true", {
          method: "HEAD",
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      405,
    );
    for (const path of [
      "/v1/messages?beta=false",
      "/v1/messages?beta=true&beta=true",
      "/v1/messages?key=secret",
      "/v1/messages?beta=%74rue",
      "/v1/messages?beta=true&other=1",
    ]) {
      assert.notEqual((await post(f.url, token, undefined, path)).status, 200, path);
    }
    for (const rawPath of ["/v1/../v1/messages?beta=true", "/v1/messages?beta=true#fragment"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          f.url,
          { method: "POST", path: rawPath, headers: { authorization: `Bearer ${token}` } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ model: "local-model", stream: true }));
      });
      assert.notEqual(status, 200, rawPath);
    }
  } finally {
    await f.gateway.close();
  }
});

test("concurrent running calls reserve generation budget without refund", async () => {
  let started = 0;
  const f = await fixture({
    maxConcurrentRequests: 2,
    model: model(async function* (signal) {
      started++;
      yield { type: "start" };
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
    }),
  });
  const token = await f.gateway.issueToken(
    binding({ maxRequests: 3, maxGenerationTokens: 100, maxOutputTokensPerRequest: 70 }),
  );
  try {
    const first = await post(f.url, token, {
      model: "local-model",
      stream: true,
      options: { maxOutputTokens: 70 },
    });
    assert.equal(first.status, 200);
    assert.equal(
      (
        await post(f.url, token, {
          model: "local-model",
          stream: true,
          options: { maxOutputTokens: 70 },
        })
      ).status,
      429,
    );
    assert.equal(started, 1);
    f.gateway.revokeToken(token);
    await first.body?.cancel().catch(() => {});
    assert.equal((await post(f.url, token)).status, 401);
  } finally {
    await f.gateway.close();
  }
});

test("revoke cancels a pending body read and does not invoke Model", async () => {
  let calls = 0;
  const f = await fixture({
    model: model(async function* () {
      calls++;
      yield { type: "start" };
    }),
  });
  const pending = request(f.url + "/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${f.token}`, "transfer-encoding": "chunked" },
  });
  pending.on("error", () => {});
  try {
    pending.write('{"model":');
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.gateway.revokeToken(f.token);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 0);
    assert.equal((await post(f.url, f.token)).status, 401);
  } finally {
    pending.destroy();
    await f.gateway.close();
  }
});

test("codec failure aborts upstream and returns a redacted terminal event", async () => {
  let upstreamSignal: AbortSignal | undefined;
  let closed = false;
  const brokenCodec: GatewayProtocolAdapter = {
    ...codec,
    async *encode(events) {
      try {
        for await (const _event of events) {
          yield { data: { safe: true } };
          throw new Error("private codec payload");
        }
      } finally {
        closed = true;
      }
    },
  };
  const f = await fixture({
    protocols: [brokenCodec],
    model: model(async function* (signal) {
      upstreamSignal = signal;
      yield { type: "start" };
    }),
  });
  try {
    const response = await post(f.url, f.token);
    const text = await response.text();
    assert.match(text, /event: error/);
    assert.doesNotMatch(text, /private codec payload/);
    assert.equal(upstreamSignal?.aborted, true);
    assert.equal(closed, true);
  } finally {
    await f.gateway.close();
  }
});

test("shutdown racing a pending model resolver never creates a credential", async () => {
  let release!: (value: Model) => void;
  const resolution = new Promise<Model>((resolve) => {
    release = resolve;
  });
  const gateway = createModelGateway({
    protocols: [codec],
    resolveModel: () => resolution,
    limits: { maxBodyBytes: 256, maxConcurrentRequests: 1 },
  });
  await gateway.start();
  const pending = gateway.issueToken(binding());
  await gateway.close();
  release(simple);
  await assert.rejects(pending, { code: "gateway_closed" });
});

test("rejected transports and bodies never invoke model; invalid token budgets fail issuance", async () => {
  let calls = 0;
  const f = await fixture({
    model: model(async function* () {
      calls++;
      yield { type: "start" };
    }),
  });
  try {
    for (const bad of [
      { maxGenerationTokens: 0 },
      { maxOutputTokensPerRequest: 0 },
      { maxGenerationTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await assert.rejects(f.gateway.issueToken(binding(bad)), { code: "invalid_binding" });
    }
    const token = await f.gateway.issueToken(binding({ maxRequests: 5 }));
    assert.equal((await post(f.url, "invalid")).status, 401);
    assert.equal((await post(f.url, token, { model: "wrong", stream: true })).status, 422);
    assert.equal((await post(f.url, token, { model: "local-model", stream: false })).status, 422);
    assert.equal(
      (
        await post(f.url, token, {
          model: "local-model",
          stream: true,
          options: { maxOutputTokens: 0 },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await fetch(f.url + "/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-upstream-url": "http://127.0.0.1:9" },
          body: JSON.stringify({ model: "local-model", stream: true }),
        })
      ).status,
      400,
    );
    assert.equal(calls, 0);
  } finally {
    await f.gateway.close();
  }
});
