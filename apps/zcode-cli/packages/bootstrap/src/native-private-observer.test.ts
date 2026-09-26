import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createPrivateObservation } from "./native-private-observer.js";

const baseUrl = "http://127.0.0.1:65530/private";
const requestUrl = `${baseUrl}/v1/messages`;
const post = { method: "POST", body: JSON.stringify({ model: "only", max_tokens: 1024 }) };

test("Model/HTTP reservations/dispatches separate; serialized method/model/query/userinfo and budget denied before IO", async () => {
  let io = 0;
  const events: string[] = [];
  const observer = createPrivateObservation({
    providerId: "fixture", modelId: "only", api: "anthropic-messages", baseUrl,
    maxAttempts: 12,
    fetch: async () => { io++; return new Response(JSON.stringify({ content: [] }), { headers: { "content-type": "application/json" } }); },
    notify: (event) => events.push(event.kind),
  });
  assert.throws(() => observer.onModelCall("stream", "wrong", "only"), /denied/);
  observer.onModelCall("stream", "fixture", "only");
  for (const [url, init] of [
    [`${baseUrl}/v1/other`, post],
    [requestUrl.replace("65530", "65531"), post],
    [`${requestUrl}?injected=1`, post],
    [requestUrl.replace("127.0.0.1", "user:pass@127.0.0.1"), post],
    [requestUrl, { method: "GET", body: post.body }],
    [requestUrl, { method: "POST", body: JSON.stringify({ model: "different", max_tokens: 1024 }) }],
  ] as const) await assert.rejects(observer.transport(url, init), /denied/);
  assert.equal(io, 0);
  await observer.transport(requestUrl, post);
  await observer.transport(requestUrl, post);
  assert.deepEqual(observer.counts, { httpAttempts: 8, httpDispatches: 2, modelCalls: 1 });
  assert.deepEqual(events, ["model", ...Array(6).fill("http"), "http", "dispatch", "http", "dispatch"]);
  assert.equal(io, observer.counts.httpDispatches);
});

test("non-2xx fake echo is sanitized before SDK error projection", async () => {
  const sentinel = "fixture-private-key-sentinel";
  let serverAttempts = 0;
  const server = createServer((_request, response) => {
    serverAttempts++;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: sentinel, endpoint: "fixture-private-endpoint-sentinel" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/private`;
    const observer = createPrivateObservation({ providerId: "fixture", modelId: "only", api: "anthropic-messages", baseUrl: url, fetch: globalThis.fetch.bind(globalThis), notify() {} });
    observer.onModelCall("stream", "fixture", "only");
    const response = await observer.transport(`${url}/v1/messages`, post);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes(sentinel), false);
    assert.equal(body.includes("fixture-private-endpoint-sentinel"), false);
    assert.equal(observer.counts.httpDispatches, serverAttempts);
  } finally { await new Promise<void>((done) => server.close(() => done())); }
});
