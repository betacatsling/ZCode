import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createPrivateObservation } from "./native-private-observer.js";

test("Model calls and SDK transport attempts are separate; wrong route/extra model and exhausted budget never reach IO", async () => {
  let io = 0;
  const events: string[] = [];
  const observer = createPrivateObservation({
    providerId: "fixture",
    modelId: "only",
    api: "anthropic-messages",
    baseUrl: "http://127.0.0.1:65530/private",
    maxAttempts: 2,
    fetch: async () => {
      io++;
      return new Response("ok");
    },
    notify: (event) => events.push(event.kind),
  });
  assert.throws(() => observer.onModelCall("stream", "wrong", "only"), /denied/);
  observer.onModelCall("stream", "fixture", "only");
  assert.throws(() => observer.transport("http://127.0.0.1:65530/private/v1/other"), /denied/);
  assert.throws(() => observer.transport("http://127.0.0.1:65531/private/v1/messages"), /denied/);
  await observer.transport("http://127.0.0.1:65530/private/v1/messages");
  await observer.transport("http://127.0.0.1:65530/private/v1/messages");
  assert.throws(() => observer.transport("http://127.0.0.1:65530/private/v1/messages"), /denied/);
  assert.throws(() => observer.onModelCall("generate", "fixture", "extra"), /denied/);
  observer.onModelCall("generate", "fixture", "only");
  assert.throws(() => observer.onModelCall("generate", "fixture", "only"), /denied/);
  assert.deepEqual(observer.counts, { httpAttempts: 2, modelCalls: 2 });
  assert.deepEqual(events, ["model", "http", "http", "model"]);
  assert.equal(io, observer.counts.httpAttempts);
});

test("fake HTTP upstream error echo of credential/endpoint is removed before SDK error projection", async () => {
  const sentinel = "fixture-private-key-sentinel";
  let serverAttempts = 0;
  const server = createServer((_request, response) => {
    serverAttempts++;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: sentinel, endpoint: "fixture-private-endpoint-sentinel" },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/private`;
    const observer = createPrivateObservation({
      providerId: "fixture",
      modelId: "only",
      api: "anthropic-messages",
      baseUrl,
      fetch: globalThis.fetch.bind(globalThis),
      notify() {},
    });
    observer.onModelCall("stream", "fixture", "only");
    const response = await observer.transport(`${baseUrl}/v1/messages`);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes(sentinel), false);
    assert.equal(body.includes("fixture-private-endpoint-sentinel"), false);
    assert.deepEqual(observer.counts, { modelCalls: 1, httpAttempts: 1 });
    assert.equal(serverAttempts, observer.counts.httpAttempts);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
