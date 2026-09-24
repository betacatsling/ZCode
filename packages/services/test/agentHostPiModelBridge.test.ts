import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createPiHostProvider } from "../src/agent-adapters/pi/piModelStream.js";
import type { Model } from "@zcode/contracts";

function model(onRequest: (request: Parameters<Model["streamText"]>[0]) => void): Model {
  return {
    providerId: "provider-a",
    modelId: "model-a",
    displayName: "Model A",
    options: { reasoningLevel: "off" },
    properties: { contextWindow: 16000 },
    optionSpecs: { maxOutputTokens: { max: 1000 } },
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
  const context = normalizeContext({
    systemPrompt: "system",
    messages: [{ role: "user", content: "say hello", timestamp: Date.now() }],
  });
  for await (const event of provider.streamSimple!(selected, context, { maxTokens: 42 }))
    events.push(event);
  assert.equal(events.at(-1)?.type, "done");
  const result = events.at(-1);
  assert.equal(
    result?.type === "done" &&
      result.message.content[0]?.type === "text" &&
      result.message.content[0].text,
    "hello",
  );
  assert.deepEqual(requests[0]?.messages, [
    { role: "system", content: "system" },
    { role: "user", content: "say hello" },
  ]);
  assert.equal(requests[0]?.options.maxOutputTokens, 42);
  assert.equal(requests[0]?.options.reasoningLevel, "off");
});

test("Pi bridge accepts committed tool input after non-JSON partial delta and reports provider usage", async () => {
  const requests: Array<Parameters<Model["streamText"]>[0]> = [];
  const fake = model((request) => requests.push(request));
  const provider = createPiHostProvider({
    ...fake,
    async *streamText(request) {
      requests.push(request);
      yield { type: "start" };
      yield { type: "reasoning_start", id: "reason" };
      yield { type: "reasoning_delta", id: "reason", text: "consider tool" };
      yield { type: "reasoning_end", id: "reason" };
      yield { type: "tool_input_start", id: "tool", toolName: "read" };
      yield { type: "tool_input_delta", id: "tool", delta: '{"path":' }; // Delta is display-only, not executable JSON.
      yield { type: "tool_input_end", id: "tool" };
      yield {
        type: "tool_call",
        toolCall: { id: "tool", name: "read", input: { path: "input.txt" } },
      };
      yield {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          inputTokens: 7,
          outputTokens: 4,
          totalTokens: 13,
          reasoningTokens: 2,
          cacheReadTokens: 2,
        },
      };
    },
  } as Model);
  const selected = (await provider.getModels())[0]!;
  const events = [];
  for await (const event of provider.streamSimple!(
    selected,
    normalizeContext({ messages: [{ role: "user", content: "read", timestamp: Date.now() }] }),
  ))
    events.push(event);
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "done");
  if (terminal?.type !== "done") return;
  assert.equal(terminal.message.usage.totalTokens, 13);
  assert.equal(terminal.message.usage.reasoning, 2);
  assert.equal(terminal.message.content[0]?.type, "thinking");
  assert.deepEqual(terminal.message.content[1], {
    type: "toolCall",
    id: "tool",
    name: "read",
    arguments: { path: "input.txt" },
  });
  assert.equal(requests.length, 1);
});

test("Pi bridge fails closed on unsupported image rather than silently dropping it", async () => {
  let calls = 0;
  const provider = createPiHostProvider(model(() => calls++));
  const selected = (await provider.getModels())[0]!;
  const context = normalizeContext({
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "image", data: "eA==", mimeType: "image/png" }],
      },
    ],
  });
  const events = [];
  for await (const event of provider.streamSimple!(selected, context)) events.push(event);
  assert.equal(events.at(-1)?.type, "error");
  assert.equal(calls, 0);
});
