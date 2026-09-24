import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEvent } from "@zcode/contracts";
import {
  decodeAnthropicMessagesRequest,
  anthropicMessagesProtocol,
} from "../src/model-gateway/ingress/anthropicMessages.js";
import { encodeAnthropicMessagesStream } from "../src/model-gateway/egress/anthropicMessages.js";

const headers = { "anthropic-version": "2023-06-01" };
const base = {
  model: "host-alias",
  max_tokens: 128,
  stream: true,
  messages: [{ role: "user", content: "Hi" }],
};
async function* source(events: ModelEvent[]): AsyncIterable<ModelEvent> {
  yield* events;
}
async function frames(events: ModelEvent[], signal?: AbortSignal) {
  const out = [];
  for await (const frame of encodeAnthropicMessagesStream(source(events), {
    requestId: "req-1",
    modelId: "host-alias",
    createdAt: 1,
    signal,
  }))
    out.push(frame);
  return out;
}

test("Messages decoder retains per-block system marker and sole tool-result marker", () => {
  const decoded = decodeAnthropicMessagesRequest({ ...base,
    system: [{ type: "text", text: "base" }, { type: "text", text: "cached", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: "run" },
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "denied", is_error: true, cache_control: { type: "ephemeral" } }] },
    ],
  }, headers);
  assert.deepEqual(decoded.request.messages, [
    { role: "system", content: "base" },
    { role: "system", content: "cached", cacheControl: { type: "ephemeral" } },
    { role: "user", content: "run" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read", input: {} }] },
    { role: "tool", content: "denied", toolCallId: "call-1", toolName: "read", isError: true, cacheControl: { type: "ephemeral" } },
  ]);
});

test("Messages decoder preserves image and single-block ephemeral cache marker", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } };
  const decoded = decodeAnthropicMessagesRequest({ ...base, messages: [
    { role: "user", content: [image, { type: "text", text: "look" }] },
    { role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
  ] }, headers);
  assert.deepEqual(decoded.request.messages, [
    { role: "user", content: [{ type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }, { type: "text", text: "look" }] },
    { role: "user", content: "cached", cacheControl: { type: "ephemeral" } },
  ]);
  const multi = decodeAnthropicMessagesRequest({ ...base, messages: [
    { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "text", text: "three", cache_control: { type: "ephemeral" } }] },
  ] }, headers);
  assert.deepEqual(multi.request.messages, [{ role: "user", content: [
    { type: "text", text: "one" }, { type: "text", text: "two" }, { type: "text", text: "three", cacheControl: { type: "ephemeral" } },
  ] }]);
});

test("Messages decoding retains system order and pairs two tool results with original tool names", () => {
  const result = decodeAnthropicMessagesRequest(
    {
      ...base,
      system: [
        { type: "text", text: "A" },
        { type: "text", text: "B" },
      ],
      tools: [
        { name: "read", input_schema: { type: "object" } },
        { name: "write", input_schema: { type: "object" } },
      ],
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Doing work" },
            { type: "tool_use", id: "call-a", name: "read", input: { path: "a" } },
            { type: "tool_use", id: "call-b", name: "write", input: { path: "b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-b", content: "ok b" },
            {
              type: "tool_result",
              tool_use_id: "call-a",
              content: [{ type: "text", text: "ok a" }],
              is_error: true,
            },
          ],
        },
      ],
    },
    headers,
  );
  assert.equal(result.modelId, "host-alias");
  assert.equal(result.stream, true);
  assert.deepEqual(result.request.messages, [
    { role: "system", content: "AB" },
    { role: "user", content: "Hi" },
    {
      role: "assistant",
      content: "Doing work",
      toolCalls: [
        { id: "call-a", name: "read", input: { path: "a" } },
        { id: "call-b", name: "write", input: { path: "b" } },
      ],
    },
    { role: "tool", content: "ok b", toolCallId: "call-b", toolName: "write", isError: false },
    { role: "tool", content: "ok a", toolCallId: "call-a", toolName: "read", isError: true },
  ]);
  assert.deepEqual(result.request.options, { maxOutputTokens: 128 });
  assert.deepEqual(
    result.request.tools?.map((t) => t.name),
    ["read", "write"],
  );
  assert.deepEqual(anthropicMessagesProtocol.paths, ["/v1/messages"]);
  assert.equal(
    anthropicMessagesProtocol.paths.includes("/v1/messages/count_tokens" as "/v1/messages"),
    false,
  );
  assert.equal(
    anthropicMessagesProtocol.paths.includes("/v1/messages/compact" as "/v1/messages"),
    false,
  );
});

test("Messages decoder preserves observed native sampling, attribution, and distinct effort", () => {
  const result = decodeAnthropicMessagesRequest({ ...base, temperature: 1,
    metadata: { user_id: "opaque-fixture" }, output_config: { effort: "high" } }, headers);
  assert.equal(result.request.temperature, 1);
  assert.equal(result.request.anthropicMetadataUserId, "opaque-fixture");
  assert.equal(result.request.anthropicEffort, "high");
  assert.deepEqual(result.request.options, { maxOutputTokens: 128 });
});

test("Messages decoder rejects unsupported headers, flags, versions, malformed tools and auxiliary payloads", () => {
  const reject = (body: unknown, h = headers) =>
    assert.throws(
      () => decodeAnthropicMessagesRequest(body, h),
      (err: unknown) =>
        typeof err === "object" &&
        err !== null &&
        "statusCode" in err &&
        "code" in err &&
        ((err as { statusCode: number }).statusCode === 400 ||
          (err as { statusCode: number }).statusCode === 422),
    );
  reject(base, { "anthropic-version": "2024-01-01" });
  reject(base, {});
  reject(base, { ...headers, "anthropic-beta": "context-management-2025-06-27" });
  reject(base, { ...headers, "anthropic-custom-flag": "enabled" });
  reject(
    {
      ...base,
      metadata: { user_id: "fixture" },
      context_management: { edits: [] },
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
    },
    {
      ...headers,
      "anthropic-beta": "claude-code-20250219,context-management-2025-06-27",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  );
  reject({ ...base, stream: false });
  reject({ ...base, context_management: {} });
  reject({ ...base, thinking: { type: "enabled", budget_tokens: 1024 } });
  reject({ ...base, output_config: { format: { type: "json_schema" } } });
  reject({ ...base, temperature: 2 });
  reject({ ...base, metadata: { user_id: "\n" } });
  reject({ ...base, output_config: { effort: "unknown" } });
  reject({
    ...base,
    tools: [{ name: "x", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
  });
  reject({
    ...base,
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", data: "private" } }] },
    ],
  });
  reject({
    ...base,
    messages: [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden" }],
      },
    ],
  });
  reject({
    ...base,
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }],
      },
    ],
  });
  reject({
    ...base,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "ok" },
          { type: "tool_result", tool_use_id: "a", content: "again" },
        ],
      },
    ],
  });
  reject({
    ...base,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "x", input: {} },
          { type: "text", text: "order lost" },
        ],
      },
    ],
  });
});

test("Messages preserves authenticated thinking history and original signature output", async () => {
  const decoded = decodeAnthropicMessagesRequest({ ...base, messages: [
    { role: "user", content: "first" },
    { role: "assistant", content: [
      { type: "thinking", thinking: "check", signature: "synthetic-signature" },
      { type: "text", text: "answer" },
    ] },
    { role: "user", content: "continue" },
  ] }, headers);
  assert.deepEqual(decoded.request.messages[1], {
    role: "assistant", content: [
      { type: "reasoning", text: "check", providerOptions: { anthropic: { signature: "synthetic-signature" } } },
      { type: "text", text: "answer" },
    ],
  });
  const out = await frames([
    { type: "reasoning_start", id: "thought" },
    { type: "reasoning_delta", id: "thought", text: "check" },
    { type: "reasoning_delta", id: "thought", text: "", providerMetadata: { anthropic: { signature: "synthetic-signature" } } },
    { type: "reasoning_end", id: "thought" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 3, outputTokens: 2 } },
  ]);
  assert.deepEqual(out.filter((item) => item.event === "content_block_delta").map((item) => (item.data as { delta: unknown }).delta), [
    { type: "thinking_delta", thinking: "check" }, { type: "signature_delta", signature: "synthetic-signature" },
  ]);
  assert.equal(out.at(-1)?.event, "message_stop");
  const unsigned = await frames([{ type: "reasoning_start", id: "r" }, { type: "reasoning_delta", id: "r", text: "check" }, { type: "reasoning_end", id: "r" }]);
  assert.equal(unsigned.at(-1)?.event, "error");
});

test("Messages terminal usage subtracts cached counts from inclusive AI SDK input tokens", async () => {
  const out = await frames([
    { type: "start" },
    { type: "finish", finishReason: "stop", usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 90, cacheWriteTokens: 20 } },
  ]);
  const delta = out.find((item) => item.event === "message_delta")?.data as { usage: unknown };
  assert.deepEqual(delta.usage, { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 90, cache_creation_input_tokens: 20 });
  const invalid = await frames([{ type: "finish", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 8, cacheReadTokens: 12 } }]);
  assert.equal(invalid.at(-1)?.event, "error");
});

test("Messages stream indexes fragmented text and two tools; usage is replacement, not cumulative", async () => {
  const out = await frames([
    { type: "start" },
    { type: "text_start", id: "text" },
    { type: "text_delta", id: "text", text: "he" },
    { type: "text_delta", id: "text", text: "llo" },
    { type: "text_end", id: "text" },
    { type: "tool_input_start", id: "a", toolName: "read" },
    { type: "tool_input_delta", id: "a", delta: '{"p":' },
    { type: "tool_input_start", id: "b", toolName: "write" },
    { type: "tool_input_delta", id: "b", delta: "{}" },
    { type: "tool_input_delta", id: "a", delta: '"a"}' },
    { type: "tool_input_end", id: "a" },
    { type: "tool_call", toolCall: { id: "a", name: "read", input: { p: "a" } } },
    { type: "tool_input_end", id: "b" },
    { type: "tool_call", toolCall: { id: "b", name: "write", input: {} } },
    { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 13, outputTokens: 9 } },
  ]);
  assert.deepEqual(
    out.map((f) => f.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.deepEqual(
    out
      .filter((f) => f.event === "content_block_start")
      .map((f) => (f.data as { index: number }).index),
    [0, 1, 2],
  );
  assert.deepEqual(
    out
      .filter(
        (f) =>
          f.event === "content_block_delta" &&
          (f.data as { delta: { type: string } }).delta.type === "input_json_delta",
      )
      .map((f) => (f.data as { index: number }).index),
    [1, 2, 1],
  );
  assert.deepEqual(out.at(-2)?.data, {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { input_tokens: 13, output_tokens: 9 },
  });
  assert.deepEqual((out[0]!.data as { message: { usage: unknown } }).message.usage, {
    input_tokens: 0,
    output_tokens: 0,
  });
});

test("Messages stream represents direct committed tool JSON and length stop without guessing usage", async () => {
  const direct = await frames([
    { type: "tool_input_start", id: "x", toolName: "read" },
    { type: "tool_input_end", id: "x" },
    { type: "tool_call", toolCall: { id: "x", name: "read", input: { file: "a" } } },
    { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 1, outputTokens: 2 } },
  ]);
  assert.deepEqual(
    (direct.find((f) => f.event === "content_block_delta")!.data as { delta: unknown }).delta,
    { type: "input_json_delta", partial_json: '{"file":"a"}' },
  );
  const length = await frames([
    { type: "start" },
    { type: "finish", finishReason: "length", usage: { inputTokens: 0, outputTokens: 4 } },
  ]);
  assert.equal(
    (length.at(-2)!.data as { delta: { stop_reason: string } }).delta.stop_reason,
    "max_tokens",
  );
});

test("Messages stream fails closed on partial JSON, errors, missing finish, reasoning and cancellation", async () => {
  for (const events of [
    [
      { type: "start" },
      { type: "tool_input_start", id: "a", toolName: "x" },
      { type: "tool_input_delta", id: "a", delta: "{bad" },
      { type: "tool_call", toolCall: { id: "a", name: "x", input: {} } },
    ],
    [{ type: "start" }, { type: "error", error: new Error("secret credential") }],
    [{ type: "start" }],
    [{ type: "start" }, { type: "reasoning_start", id: "r" }],
    [
      { type: "text_start", id: "a" },
      { type: "text_start", id: "b" },
      { type: "text_delta", text: "ambiguous" },
    ],
    [
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        providerMetadata: { signature: "private" },
      },
    ],
    [
      { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "error", error: new Error("late") },
    ],
  ] as ModelEvent[][]) {
    const out = await frames(events);
    assert.equal(out.at(-1)?.event, "error");
    assert.deepEqual(out.at(-1)?.data, {
      type: "error",
      error: { type: "api_error", message: "Model stream could not be completed" },
    });
    assert.equal(
      out.some((f) => f.event === "message_stop"),
      false,
    );
    assert.equal(JSON.stringify(out).includes("secret credential"), false);
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = await frames(
    [{ type: "finish", finishReason: "stop", usage: {} }],
    controller.signal,
  );
  assert.deepEqual(cancelled.at(-1)?.data, {
    type: "error",
    error: { type: "request_cancelled", message: "Request cancelled" },
  });
});
