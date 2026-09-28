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
  assert.equal(requests[0]?.systemInstructions, undefined);
  assert.equal(requests[0]?.options.maxOutputTokens, 42);
  assert.equal(requests[0]?.options.reasoningLevel, "off");
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

test("Pi bridge preserves provider reasoning chunks as structured thinking", async () => {
  const provider = createPiHostProvider({
    ...model(() => {}),
    async *streamText() {
      yield { type: "start", modelId: "model-a" };
      yield { type: "reasoning_start", id: "thinking-1" };
      yield { type: "reasoning_delta", id: "thinking-1", text: "private reasoning" };
      yield { type: "reasoning_end", id: "thinking-1" };
      yield { type: "text_start", id: "text-1" };
      yield { type: "text_delta", id: "text-1", text: "visible" };
      yield { type: "text_end", id: "text-1" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } };
    },
  } as unknown as Model);
  const selected = (await provider.getModels())[0]!;
  const context = normalizeContext({
    messages: [{ role: "user", timestamp: Date.now(), content: "say visible" }],
  });
  const events = [];
  for await (const event of provider.streamSimple!(selected, context, { maxTokens: 42 }))
    events.push(event);
  assert.equal(events.at(-1)?.type, "done");
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("thinking_")).map((event) => event.type),
    ["thinking_start", "thinking_delta", "thinking_end"],
  );
  const result = events.at(-1);
  assert.equal(
    result?.type === "done" &&
      result.message.content.some(
        (part) => part.type === "thinking" && part.thinking === "private reasoning",
      ),
    true,
  );
  assert.equal(
    result?.type === "done" &&
      result.message.content.some((part) => part.type === "text" && part.text === "visible"),
    true,
  );
});

test("Pi bridge round-trips same-route reasoning and tool history, but rejects foreign routes", async () => {
  const requests: Array<Parameters<Model["streamText"]>[0]> = [];
  const provider = createPiHostProvider(model((request) => requests.push(request)));
  const selected = (await provider.getModels())[0]!;
  const context = normalizeContext({
    messages: [
      { role: "user", content: "read then use the tool", timestamp: Date.now() },
      {
        role: "assistant",
        api: "zcode-model-executor",
        provider: "zcode-host",
        model: "provider-a/model-a",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "input.txt" } },
          { type: "text", text: "I read it" },
        ],
        usage: {
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: Date.now(),
      },
    ] as never,
  });
  for await (const _event of provider.streamSimple!(selected, context, { maxTokens: 42 })) {
    /* consume */
  }
  const assistant = requests[0]?.messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.providerId, "provider-a");
  assert.equal(assistant?.modelId, "model-a");
  assert.deepEqual(assistant?.content, [
    { type: "reasoning", text: "private reasoning" },
    { type: "text", text: "I read it" },
  ]);
  assert.deepEqual(assistant?.toolCalls, [
    { id: "tool-1", name: "read", input: { path: "input.txt" } },
  ]);
  const foreignContext = normalizeContext({
    messages: [
      {
        role: "assistant",
        api: "zcode-model-executor",
        provider: "other-host",
        model: "other/model",
        content: [{ type: "text", text: "foreign" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ] as never,
  });
  const foreignEvents = [];
  for await (const event of provider.streamSimple!(selected, foreignContext, { maxTokens: 42 }))
    foreignEvents.push(event);
  assert.equal(foreignEvents.at(-1)?.type, "error");
  assert.equal(requests.length, 1);
});
