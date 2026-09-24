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
  effectiveSelection: { providerId: "provider-a", modelId: "model-a" },
  expiresAt: Date.now() + 60_000,
  maxRequests: 2,
  maxOutputBytes: 2000,
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
      request: { messages: [{ role: "user", content: "hi" }] },
    };
  },
  async *encode(events) {
    for await (const event of events) yield { event: "message", data: event };
  },
};
function model(stream: (signal: AbortSignal | undefined) => AsyncIterable<ModelEvent>): Model {
  return {
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
    resolveModel?: () => Model;
  } = {},
) {
  const gateway = createModelGateway({
    protocols: [codec],
    resolveModel: options.resolveModel ?? (() => options.model ?? simple),
    limits: {
      maxBodyBytes: options.maxBodyBytes ?? 256,
      maxConcurrentRequests: options.maxConcurrentRequests ?? 1,
    },
  });
  const address = await gateway.start();
  return { gateway, url: address.url, token: gateway.issueToken(binding()) };
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
    assert.equal((await post(f.url + "?upstream=https://example.org", f.token)).status, 400);
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
    const token = gateway.issueToken(binding());
    assert.equal((await post(url, token, undefined, "/v1/messages")).status, 403);
    const other = gateway.issueToken(binding({ protocol: "anthropic-messages" }));
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
    const expired = f.gateway.issueToken(
      binding({ expiresAt: Date.now() + 20, runtimeEpoch: "old" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal((await post(f.url, expired)).status, 401);
    const stale = f.gateway.issueToken(binding({ runtimeEpoch: "old" }));
    f.gateway.revokeToken(stale);
    assert.equal((await post(f.url, stale)).status, 401);
    const once = f.gateway.issueToken(binding({ maxRequests: 1 }));
    assert.equal((await post(f.url, once)).status, 200);
    assert.equal((await post(f.url, once)).status, 429);
  } finally {
    await f.gateway.close();
  }
  const wrong = await fixture({ resolveModel: () => ({ ...simple, modelId: "other" }) });
  try {
    assert.equal((await post(wrong.url, wrong.token)).status, 403);
  } finally {
    await wrong.gateway.close();
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
    const next = f.gateway.issueToken(binding());
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
    const short = f.gateway.issueToken(binding({ expiresAt: Date.now() + 80 }));
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
  assert.throws(() => f.gateway.issueToken(binding()));
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
      const short = limited.gateway.issueToken(binding({ maxOutputBytes: 120 }));
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
