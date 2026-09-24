import assert from "node:assert/strict";
import test from "node:test";
import { modelRequestJsonSchema, type ModelEvent } from "@zcode/contracts";
import { z } from "zod";
import {
  decodeResponsesRequest,
  responsesProtocol,
} from "../src/model-gateway/ingress/responses.js";
import { encodeResponsesStream } from "../src/model-gateway/egress/responses.js";
import defaultCodex from "./fixtures/codexResponsesDefault.json" with { type: "json" };
import codexFixture from "./fixtures/codexCompatibility0.156.1.fixture.json" with { type: "json" };

const base = {
  model: "bound-model",
  stream: true,
  input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
};
const ctx = { requestId: "req-1", modelId: "bound-model", createdAt: 123 };
async function collect(events: ModelEvent[], signal?: AbortSignal) {
  async function* source() {
    yield* events;
  }
  return Array.fromAsync(encodeResponsesStream(source(), { ...ctx, signal }));
}
const kinds = (frames: Awaited<ReturnType<typeof collect>>) => frames.map((frame) => frame.event);

test("Responses decoder preserves system instruction order, paired multiple tool calls and outputs", () => {
  const input = {
    ...base,
    instructions: "first",
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "second" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", name: "read", call_id: "call-a", arguments: '{"path":"a"}' },
      { type: "function_call", name: "read", call_id: "call-b", arguments: '{"path":"b"}' },
      { type: "function_call_output", call_id: "call-b", output: "B" },
      { type: "function_call_output", call_id: "call-a", output: "A" },
    ],
    tools: [{ type: "function", name: "read", parameters: { type: "object" }, strict: true }],
    store: false,
    parallel_tool_calls: true,
    tool_choice: "auto",
    reasoning: { effort: "none" },
    include: ["reasoning.encrypted_content"],
  };
  const result = decodeResponsesRequest(input, {});
  assert.equal(result.modelId, "bound-model");
  assert.deepEqual(result.request.messages, [
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "checking" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-a", name: "read", input: { path: "a" } }],
    },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-b", name: "read", input: { path: "b" } }],
    },
    { role: "tool", content: "B", toolCallId: "call-b", toolName: "read" },
    { role: "tool", content: "A", toolCallId: "call-a", toolName: "read" },
  ]);
  assert.equal(result.request.tools?.[0]?.strict, true);
  assert.equal(responsesProtocol.paths[0], "/v1/responses");
  assert.deepEqual(
    decodeResponsesRequest({ ...base, input: "simple prompt" }, {}).request.messages,
    [{ role: "user", content: "simple prompt" }],
  );
});

test("Responses keeps pinned native developer instructions as developer, never system", () => {
  const pinned = codexFixture.cases.find((entry) => entry.name === "optional-tools-disabled")
    ?.request.body;
  assert.ok(pinned);
  const decoded = decodeResponsesRequest(pinned, {});
  assert.equal(decoded.request.promptCacheKey, pinned.prompt_cache_key);
  assert.equal(decoded.request.messages[0]?.role, "system");
  assert.equal(decoded.request.messages[1]?.role, "developer");
  assert.equal(
    decoded.request.messages[1]?.content,
    pinned.input[0]?.content?.map((part) => part.text).join(""),
  );
});

test("pinned Codex cache affinity passes the independent strict Gateway ModelRequest schema", () => {
  const pinned = codexFixture.cases.find((entry) => entry.name === "optional-tools-disabled")
    ?.request.body;
  assert.ok(pinned);
  const request = decodeResponsesRequest(pinned, {}).request;
  const schema = z.fromJSONSchema(modelRequestJsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
  assert.equal(schema.safeParse(request).success, true);
  assert.equal(schema.safeParse({ ...request, promptCacheKey: "" }).success, false);
  assert.equal(schema.safeParse({ ...request, promptCacheKey: "x".repeat(257) }).success, false);
  assert.equal(schema.safeParse({ ...request, runtimeAuth: "untrusted" }).success, false);
});

test("Responses system-only instructions retain order without developer role promotion", () => {
  const result = decodeResponsesRequest(
    {
      ...base,
      instructions: "first",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "second" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    },
    {},
  );
  assert.deepEqual(result.request.messages, [
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "hello" },
  ]);
});

test("Responses decoder fails closed on actual pinned Codex default and malformed/unknown features", () => {
  assert.throws(() => decodeResponsesRequest(defaultCodex, {}), {
    code: "unsupported_tool",
    statusCode: 422,
  });
  const cases: Array<[unknown, string]> = [
    [{ ...base, stream: false }, "unsupported_stream_mode"],
    [{ ...base, temperature: 0.5 }, "unsupported_parameter"],
    [
      {
        ...base,
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,YQ==" }],
          },
        ],
      },
      "unsupported_content",
    ],
    [
      { ...base, input: [{ type: "function_call_output", call_id: "missing", output: "x" }] },
      "unpaired_tool_result",
    ],
    [
      { ...base, input: [{ type: "function_call", name: "read", call_id: "a", arguments: "{" }] },
      "invalid_tool_arguments",
    ],
    [
      { ...base, tools: [{ type: "namespace", name: "multi_agent_v1", tools: [] }] },
      "unsupported_tool",
    ],
    [{ ...base, tools: [{ type: "web_search" }] }, "unsupported_tool"],
    [{ ...base, reasoning: { effort: "low" } }, "unsupported_reasoning"],
    [{ ...base, tool_choice: "required" }, "unsupported_tool_choice"],
    [{ ...base, prompt_cache_key: "" }, "invalid_request"],
    [{ ...base, prompt_cache_key: 5 }, "invalid_request"],
    [{ ...base, prompt_cache_key: "x".repeat(257) }, "invalid_request"],
  ];
  for (const [body, code] of cases) assert.throws(() => decodeResponsesRequest(body, {}), { code });
});

test("Responses SSE emits ordered stable text and two function items, complete JSON and true usage replacement", async () => {
  const frames = await collect([
    { type: "start" },
    { type: "text_start", id: "text" },
    { type: "text_delta", id: "text", text: "hel" },
    { type: "text_delta", id: "text", text: "lo" },
    { type: "text_end", id: "text" },
    { type: "tool_input_start", id: "call-a", toolName: "read" },
    { type: "tool_input_delta", id: "call-a", delta: '{"p":' },
    { type: "tool_input_delta", id: "call-a", delta: "1}" },
    { type: "tool_input_end", id: "call-a" },
    { type: "tool_call", toolCall: { id: "call-a", name: "read", input: { p: 1 } } },
    { type: "tool_input_start", id: "call-b", toolName: "write" },
    { type: "tool_input_delta", id: "call-b", delta: "{}" },
    { type: "tool_input_end", id: "call-b" },
    { type: "tool_call", toolCall: { id: "call-b", name: "write", input: {} } },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    },
  ]);
  assert.deepEqual(kinds(frames), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const terminal = frames.at(-1);
  assert.ok(terminal);
  const response = (
    terminal.data as { response: { output: Array<Record<string, unknown>>; usage: unknown } }
  ).response;
  assert.equal(response.output.length, 3);
  assert.deepEqual(
    response.output.map((item) => item.id),
    ["req-1-item-0", "req-1-item-1", "req-1-item-2"],
  );
  assert.deepEqual(
    response.output.map((item) => item.call_id),
    [undefined, "call-a", "call-b"],
  );
  assert.deepEqual(response.output[0]?.content, [{ type: "output_text", text: "hello" }]);
  assert.deepEqual(response.usage, { input_tokens: 12, output_tokens: 5, total_tokens: 17 });
});

test("Responses maps plain live reasoning without inventing encrypted history and replays only original opaque content", async () => {
  const plain = await collect([
    { type: "reasoning_start", id: "r" },
    { type: "reasoning_delta", id: "r", text: "synthetic thought" },
    { type: "reasoning_end", id: "r" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 4 } },
  ]);
  const item = plain.find((frame) => frame.event === "response.output_item.done")?.data as {
    item: Record<string, unknown>;
  };
  assert.deepEqual(item.item.summary, [{ type: "summary_text", text: "synthetic thought" }]);
  assert.equal("encrypted_content" in item.item, false);
  assert.equal(plain.at(-1)?.event, "response.completed");
  const encrypted = await collect([
    {
      type: "reasoning_start",
      id: "r",
      providerMetadata: {
        openai: { itemId: "reasoning-original", reasoningEncryptedContent: "synthetic-opaque" },
      },
    },
    { type: "reasoning_delta", id: "r", text: "text" },
    { type: "reasoning_end", id: "r" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 4 } },
  ]);
  const original = encrypted.find((frame) => frame.event === "response.output_item.done")?.data as {
    item: Record<string, unknown>;
  };
  assert.equal(original.item.id, "reasoning-original");
  assert.equal(original.item.encrypted_content, "synthetic-opaque");
  const replay = decodeResponsesRequest(
    {
      ...base,
      input: [
        {
          type: "reasoning",
          id: "reasoning-original",
          encrypted_content: "synthetic-opaque",
          summary: [{ type: "summary_text", text: "text" }],
        },
        { role: "user", content: "continue" },
      ],
    },
    {},
  );
  assert.deepEqual(replay.request.messages[0], {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "text",
        providerOptions: {
          openai: { itemId: "reasoning-original", reasoningEncryptedContent: "synthetic-opaque" },
        },
      },
    ],
  });
  assert.throws(
    () =>
      decodeResponsesRequest(
        {
          ...base,
          input: [
            { type: "reasoning", id: "r", summary: [{ type: "summary_text", text: "text" }] },
          ],
        },
        {},
      ),
    { code: "unsupported_reasoning" },
  );
});

test("Responses validates inclusive cached usage and never completes before stream exhaustion", async () => {
  const valid = await collect([
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 10 },
    },
  ]);
  const completed = valid.find((item) => item.event === "response.completed")?.data as {
    response: { usage: unknown };
  };
  assert.deepEqual(completed.response.usage, {
    input_tokens: 20,
    output_tokens: 4,
    total_tokens: 24,
    input_tokens_details: { cached_tokens: 10 },
  });
  const invalid = await collect([
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 4, cacheReadTokens: 10 },
    },
  ]);
  assert.equal(invalid.at(-1)?.event, "response.failed");
  assert.equal(
    invalid.some((item) => item.event === "response.completed"),
    false,
  );
  const afterFinish = await collect([
    { type: "finish", finishReason: "stop", usage: { inputTokens: 5, outputTokens: 4 } },
    { type: "error", error: new Error("synthetic") },
  ]);
  assert.equal(afterFinish.at(-1)?.event, "response.failed");
  assert.equal(
    afterFinish.some((item) => item.event === "response.completed"),
    false,
  );
});

test("Responses final text snapshot replaces deltas and finish token usage is not summed", async () => {
  const frames = await collect([
    { type: "text_start", id: "a" },
    { type: "text_delta", id: "a", text: "hello" },
    { type: "text_end", id: "a" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cacheReadTokens: 2 },
    },
  ]);
  const terminal = frames.at(-1);
  assert.ok(terminal);
  assert.equal(terminal.event, "response.completed");
  const snapshot = (
    terminal.data as { response: { output: Array<{ content: unknown }>; usage: unknown } }
  ).response;
  assert.deepEqual(snapshot.output[0]?.content, [{ type: "output_text", text: "hello" }]);
  assert.deepEqual(snapshot.usage, {
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 2 },
  });
  assert.equal(frames.filter((frame) => frame.event === "response.output_item.done").length, 1);
});

test("Responses stream fails rather than completing on malformed JSON, error, cancel and missing finish", async () => {
  for (const events of [
    [
      { type: "tool_input_start", id: "call", toolName: "read" },
      { type: "tool_input_delta", id: "call", delta: "{" },
      { type: "tool_input_end", id: "call" },
    ] as ModelEvent[],
    [{ type: "error", error: new Error("secret upstream URL") }] as ModelEvent[],
    [{ type: "reasoning_start", id: "private" }] as ModelEvent[],
    [] as ModelEvent[],
  ]) {
    const frames = await collect(events);
    assert.equal(frames.at(-1)?.event, "response.failed");
    assert.equal(JSON.stringify(frames).includes("secret upstream URL"), false);
  }
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    (await collect([{ type: "finish", finishReason: "stop", usage: {} }], abort.signal)).at(-1)
      ?.event,
    "response.failed",
  );
  const duringStream = new AbortController();
  async function* cancelledSource(): AsyncIterable<ModelEvent> {
    yield { type: "text_start", id: "partial" };
    yield { type: "text_delta", id: "partial", text: "partial" };
    duringStream.abort();
    yield { type: "text_end", id: "partial" };
    yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  const cancelled = await Array.fromAsync(
    encodeResponsesStream(cancelledSource(), { ...ctx, signal: duringStream.signal }),
  );
  assert.equal(cancelled.at(-1)?.event, "response.failed");
  assert.equal(
    cancelled.some((frame) => frame.event === "response.completed"),
    false,
  );
});
