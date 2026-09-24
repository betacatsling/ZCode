import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createPiHostProvider } from "../src/agent-adapters/pi/piModelStream.js";
import type { Model } from "@zcode/contracts";

const route = {
  providerId: "provider-a",
  modelId: "model-a",
  apiType: "anthropic-messages",
  endpointFingerprint: "a".repeat(64),
};

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

test("Pi Anthropic signature survives native-style history and returns to the same Model route", async () => {
  const requests: Array<Parameters<Model["streamText"]>[0]> = [];
  const provider = createPiHostProvider(
    {
      ...model((request) => requests.push(request)),
      async *streamText(request) {
        requests.push(request);
        yield { type: "start" } as const;
        yield { type: "reasoning_start", id: "r" } as const;
        yield { type: "reasoning_delta", id: "r", text: "thought" } as const;
        yield {
          type: "reasoning_delta",
          id: "r",
          text: "",
          providerMetadata: { anthropic: { signature: "opaque-fixture" } },
        } as const;
        yield { type: "reasoning_end", id: "r" } as const;
        yield { type: "tool_input_start", id: "read-1", toolName: "read" } as const;
        yield { type: "tool_input_delta", id: "read-1", delta: '{"path":"input.txt"}' } as const;
        yield { type: "tool_input_end", id: "read-1" } as const;
        yield {
          type: "tool_call",
          toolCall: { id: "read-1", name: "read", input: { path: "input.txt" } },
        } as const;
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 2, outputTokens: 3 },
        } as const;
      },
    } as Model,
    route,
  );
  const selected = (await provider.getModels())[0]!;
  const events = [];
  for await (const event of provider.streamSimple!(
    selected,
    normalizeContext({
      messages: [{ role: "user", content: "read", timestamp: Date.now() }],
    }),
  ))
    events.push(event);
  const done = events.at(-1);
  assert.equal(done?.type, "done");
  if (done?.type !== "done") return;
  const reasoning = done.message.content[0];
  assert.equal(reasoning?.type, "thinking");
  if (reasoning?.type !== "thinking") return;
  assert.ok(reasoning.thinkingSignature);
  assert.equal(reasoning.thinkingSignature.includes("opaque-fixture"), true);
  const followup = [];
  for await (const event of provider.streamSimple!(
    selected,
    normalizeContext({
      messages: [
        { role: "user", content: "read", timestamp: Date.now() },
        done.message,
        {
          role: "toolResult",
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: Date.now(),
        },
        { role: "user", content: "follow up", timestamp: Date.now() },
      ],
    }),
  ))
    followup.push(event);
  assert.equal(followup.at(-1)?.type, "done");
  assert.deepEqual(
    requests[1]?.messages.find((m) => m.role === "assistant"),
    {
      role: "assistant",
      providerId: "provider-a",
      modelId: "model-a",
      content: [
        {
          type: "reasoning",
          text: "thought",
          providerOptions: { anthropic: { signature: "opaque-fixture" } },
        },
      ],
      toolCalls: [{ id: "read-1", name: "read", input: { path: "input.txt" } }],
    },
  );
});

test("Pi signature rejects cross-route replay and unknown metadata without leaking values", async () => {
  let calls = 0;
  const provider = createPiHostProvider(
    model(() => calls++),
    route,
  );
  const selected = (await provider.getModels())[0]!;
  const signed = {
    role: "assistant" as const,
    api: "zcode-model-executor" as const,
    provider: "zcode-host",
    model: "provider-a/model-a",
    timestamp: Date.now(),
    stopReason: "stop" as const,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [
      {
        type: "thinking" as const,
        thinking: "safe",
        thinkingSignature: JSON.stringify({
          v: 1,
          kind: "zcode-reasoning",
          providerId: "other-provider",
          modelId: "model-a",
          apiType: route.apiType,
          endpointFingerprint: route.endpointFingerprint,
          providerMetadata: { anthropic: { signature: "DO-NOT-LOG" } },
        }),
      },
    ],
  };
  const rejected = [];
  for await (const event of provider.streamSimple!(
    selected,
    normalizeContext({
      messages: [{ role: "user", content: "start", timestamp: Date.now() }, signed],
    }),
  ))
    rejected.push(event);
  assert.equal(rejected.at(-1)?.type, "error");
  assert.equal(calls, 0);
  // 同一 provider/model 的 API 协议或端点换路由，也不得重放旧签名。
  for (const changed of [
    { providerId: route.providerId, apiType: "openai-responses" },
    { providerId: route.providerId, apiType: route.apiType, endpointFingerprint: "b".repeat(64) },
  ]) {
    const envelope = JSON.parse(signed.content[0]!.thinkingSignature);
    const foreign = {
      ...signed,
      content: [
        { ...signed.content[0]!, thinkingSignature: JSON.stringify({ ...envelope, ...changed }) },
      ],
    };
    const events = [];
    for await (const event of provider.streamSimple!(
      selected,
      normalizeContext({
        messages: [{ role: "user", content: "start", timestamp: Date.now() }, foreign],
      }),
    ))
      events.push(event);
    assert.equal(events.at(-1)?.type, "error");
    assert.equal(
      events.at(-1)?.type === "error" && events.at(-1)?.error.errorMessage,
      "reasoning signature route mismatch",
    );
    assert.equal(calls, 0);
  }
  const absentRoute = createPiHostProvider(model(() => calls++));
  const noIdentity = [];
  for await (const event of absentRoute.streamSimple!(
    (await absentRoute.getModels())[0]!,
    normalizeContext({
      messages: [{ role: "user", content: "start", timestamp: Date.now() }, signed],
    }),
  ))
    noIdentity.push(event);
  assert.equal(noIdentity.at(-1)?.type, "error");
  assert.equal(calls, 0);
  const unsignedRoute = createPiHostProvider({
    ...model(() => calls++),
    async *streamText() {
      yield { type: "reasoning_start", id: "r" } as const;
      yield {
        type: "reasoning_delta",
        id: "r",
        text: "",
        providerMetadata: { anthropic: { signature: "hidden" } },
      } as const;
      yield { type: "reasoning_end", id: "r" } as const;
      yield { type: "finish", finishReason: "stop", usage: {} } as const;
    },
  } as Model);
  const unsignedEvents = [];
  for await (const event of unsignedRoute.streamSimple!(
    (await unsignedRoute.getModels())[0]!,
    normalizeContext({ messages: [{ role: "user", content: "start", timestamp: Date.now() }] }),
  ))
    unsignedEvents.push(event);
  assert.equal(unsignedEvents.at(-1)?.type, "error");
  assert.equal(JSON.stringify(unsignedEvents).includes("hidden"), false);
  const unknown = createPiHostProvider(
    {
      ...model(() => calls++),
      async *streamText() {
        yield { type: "reasoning_start", id: "r" } as const;
        yield {
          type: "reasoning_delta",
          id: "r",
          text: "",
          providerMetadata: { anthropic: { alien: "SECRET" } },
        } as const;
      },
    } as Model,
    route,
  );
  const failures = [];
  for await (const event of unknown.streamSimple!(
    (await unknown.getModels())[0]!,
    normalizeContext({ messages: [{ role: "user", content: "go", timestamp: Date.now() }] }),
  ))
    failures.push(event);
  assert.equal(failures.at(-1)?.type, "error");
  assert.equal(JSON.stringify(failures).includes("SECRET"), false);
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
