import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createPiHostProvider } from "../src/agent-adapters/pi/piModelStream.js";
import type { Model } from "@zcode/contracts";

function model(onRequest: (request: Parameters<Model["streamText"]>[0]) => void): Model {
  return {
    providerId: "provider-a", modelId: "model-a", displayName: "Model A", options: { reasoningLevel: "off" },
    properties: { contextWindow: 16000 }, optionSpecs: { maxOutputTokens: { max: 1000 } },
    async *streamText(request) {
      onRequest(request);
      yield { type: "start", modelId: "model-a" };
      yield { type: "text_start", id: "text-1" };
      yield { type: "text_delta", id: "text-1", text: "hello" };
      yield { type: "text_end", id: "text-1" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 1 } };
    },
  } as unknown as Model;
}

test("Pi provider sends text to the existing ZCode model executor and returns the same result", async () => {
  const requests: Array<Parameters<Model["streamText"]>[0]> = [];
  const provider = createPiHostProvider(model((request) => requests.push(request)));
  const selected = (await provider.getModels())[0]!;
  const events = [];
  const context = normalizeContext({ systemPrompt: "system", messages: [{ role: "user", content: "say hello", timestamp: Date.now() }] });
  for await (const event of provider.streamSimple!(selected, context, { maxTokens: 42 })) events.push(event);
  assert.equal(events.at(-1)?.type, "done");
  const result = events.at(-1);
  assert.equal(result?.type === "done" && result.message.content[0]?.type === "text" && result.message.content[0].text, "hello");
  assert.deepEqual(requests[0]?.messages, [{ role: "system", content: "system" }, { role: "user", content: "say hello" }]);
  assert.equal(requests[0]?.options.maxOutputTokens, 42);
  assert.equal(requests[0]?.options.reasoningLevel, "off");
});

test("Pi bridge fails closed on unsupported image rather than silently dropping it", async () => {
  let calls = 0;
  const provider = createPiHostProvider(model(() => calls++));
  const selected = (await provider.getModels())[0]!;
  const context = normalizeContext({ messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "image", data: "eA==", mimeType: "image/png" }] }] });
  const events = [];
  for await (const event of provider.streamSimple!(selected, context)) events.push(event);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(calls, 0);
});
