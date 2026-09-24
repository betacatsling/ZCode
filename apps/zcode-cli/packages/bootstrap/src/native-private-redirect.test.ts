import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createPrivateObservation } from "./native-private-observer.js";

test("private transport does not follow an unobserved HTTP redirect to another route", async () => {
  let visited = 0;
  let redirected = 0;
  const server = createServer((request, response) => {
    visited++;
    if (request.url === "/unapproved") redirected++;
    response.writeHead(302, { location: "/unapproved" });
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const observer = createPrivateObservation({
      providerId: "fixture",
      modelId: "only",
      api: "anthropic-messages",
      baseUrl,
      fetch: globalThis.fetch.bind(globalThis),
      notify() {},
    });
    observer.onModelCall("stream", "fixture", "only");
    const response = await observer.transport(`${baseUrl}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "only", max_tokens: 1024 }) });
    assert.equal(response.status, 302);
    assert.equal(visited, 1);
    assert.equal(redirected, 0);
    assert.equal(observer.counts.httpAttempts, visited);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
