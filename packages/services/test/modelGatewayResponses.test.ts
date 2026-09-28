import assert from "node:assert/strict";
import test from "node:test";
import type { ModelStreamEvent } from "@zcode/contracts";
import { ModelGatewayProtocolError } from "../src/model-gateway/domain/errors.js";
import { decodeResponsesRequest } from "../src/model-gateway/domain/responsesDecoder.js";
import { ResponsesStreamEncoder } from "../src/model-gateway/domain/responsesStreamEncoder.js";

const codexRequest = () => ({
  client_metadata: { session_id: "codex-session", thread_id: "thread-1", turn_id: "turn-1" },
  include: ["reasoning.encrypted_content"],
  input: [
    {
      type: "message",
      id: "msg-dev",
      role: "developer",
      content: [{ type: "input_text", text: "Developer instruction" }],
    },
    {
      type: "message",
      id: "msg-user",
      role: "user",
      content: [{ type: "input_text", text: "Say hello" }],
    },
  ],
  instructions: "Top-level system instruction",
  model: "fixture-model",
  parallel_tool_calls: true,
  prompt_cache_key: "cache-key-not-forwarded",
  reasoning: { effort: "none" },
  store: false,
  stream: true,
  tool_choice: "auto",
  tools: [
    {
      type: "function",
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false,
      },
      strict: false,
    },
  ],
});

test("Responses decoder preserves system instructions separately from developer messages", () => {
  const base = codexRequest();
  const request = {
    ...base,
    client_metadata: { ...base.client_metadata, "x-codex-turn-metadata": "x".repeat(693) },
  };
  const decoded = decodeResponsesRequest(request, "fixture-model");
  assert.equal(decoded.systemInstructions, "Top-level system instruction");
  assert.deepEqual(decoded.messages, [
    { role: "developer", content: [{ type: "text", text: "Developer instruction" }] },
    { role: "user", content: [{ type: "text", text: "Say hello" }] },
  ]);
  assert.equal(decoded.clientSessionId, "codex-session");
  assert.equal(decoded.clientThreadId, "thread-1");
  assert.equal(decoded.promptCacheKey, "cache-key-not-forwarded");
  assert.deepEqual(
    decoded.tools.map((tool) => tool.name),
    ["exec_command"],
  );
});

test("Responses decoder pairs a single function call with exactly one later output", () => {
  const request = {
    ...codexRequest(),
    input: [
      {
        type: "function_call",
        id: "item-1",
        call_id: "call-1",
        name: "exec_command",
        arguments: '{"cmd":"pwd"}',
      },
      { type: "function_call_output", id: "item-2", call_id: "call-1", output: "/tmp/workspace" },
    ],
  };
  const decoded = decodeResponsesRequest(request, "fixture-model");
  assert.deepEqual(decoded.messages, [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "exec_command", input: { cmd: "pwd" } }],
    },
    { role: "tool", content: "/tmp/workspace", toolCallId: "call-1", toolName: "exec_command" },
  ]);
  for (const input of [
    [{ type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" }],
    [{ type: "function_call_output", call_id: "orphan", output: "x" }],
    [
      { type: "function_call", call_id: "call-1", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "one" },
      { type: "function_call_output", call_id: "call-1", output: "two" },
    ],
  ]) {
    assert.throws(
      () => decodeResponsesRequest({ ...codexRequest(), input }, "fixture-model"),
      ModelGatewayProtocolError,
    );
  }
});

test("Responses decoder batches only adjacent same-round calls and preserves tool output order", () => {
  const decoded = decodeResponsesRequest(
    {
      ...codexRequest(),
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Preparing." }],
        },
        {
          type: "function_call",
          call_id: "call-a",
          name: "exec_command",
          arguments: '{"cmd":"a"}',
        },
        {
          type: "function_call",
          call_id: "call-b",
          name: "exec_command",
          arguments: '{"cmd":"b"}',
        },
        { type: "function_call_output", call_id: "call-a", output: "result-a" },
        { type: "function_call_output", call_id: "call-b", output: "result-b" },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "next round" }],
        },
        {
          type: "function_call",
          call_id: "call-c",
          name: "exec_command",
          arguments: '{"cmd":"c"}',
        },
        { type: "function_call_output", call_id: "call-c", output: "result-c" },
      ],
    },
    "fixture-model",
  );
  assert.deepEqual(decoded.messages, [
    {
      role: "assistant",
      content: [{ type: "text", text: "Preparing." }],
      toolCalls: [
        { id: "call-a", name: "exec_command", input: { cmd: "a" } },
        { id: "call-b", name: "exec_command", input: { cmd: "b" } },
      ],
    },
    { role: "tool", content: "result-a", toolCallId: "call-a", toolName: "exec_command" },
    { role: "tool", content: "result-b", toolCallId: "call-b", toolName: "exec_command" },
    {
      role: "assistant",
      content: [{ type: "text", text: "next round" }],
      toolCalls: [{ id: "call-c", name: "exec_command", input: { cmd: "c" } }],
    },
    { role: "tool", content: "result-c", toolCallId: "call-c", toolName: "exec_command" },
  ]);
});

test("Responses decoder keeps empty top-level instructions and leading system input distinct from developer", () => {
  const decoded = decodeResponsesRequest(
    {
      ...codexRequest(),
      instructions: "",
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "System layer" }],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Developer layer" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "User input" }] },
      ],
    },
    "fixture-model",
  );
  assert.equal(decoded.systemInstructions, "\n\nSystem layer");
  assert.deepEqual(decoded.messages, [
    { role: "developer", content: [{ type: "text", text: "Developer layer" }] },
    { role: "user", content: [{ type: "text", text: "User input" }] },
  ]);
});

test("Responses decoder rejects a system instruction that would follow conversation input", () => {
  assert.throws(
    () =>
      decodeResponsesRequest(
        {
          ...codexRequest(),
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
            { type: "message", role: "system", content: [{ type: "input_text", text: "late" }] },
          ],
        },
        "fixture-model",
      ),
    ModelGatewayProtocolError,
  );
});

test("Responses decoder rejects unknown, multimodal, reasoning, and non-function tool shapes", () => {
  const cases = [
    { ...codexRequest(), private_extension: true },
    {
      ...codexRequest(),
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }],
        },
      ],
    },
    { ...codexRequest(), reasoning: { effort: "medium" } },
    { ...codexRequest(), reasoning: { effort: "none", summary: "none" } },
    { ...codexRequest(), parallel_tool_calls: false },
    {
      ...codexRequest(),
      client_metadata: {
        session_id: "s",
        thread_id: "t",
        "x-codex-turn-metadata": "x".repeat(16_385),
      },
    },
    { ...codexRequest(), tools: [{ type: "web_search" }] },
    { ...codexRequest(), model: "different-model" },
  ];
  for (const request of cases) {
    assert.throws(
      () => decodeResponsesRequest(request, "fixture-model"),
      ModelGatewayProtocolError,
    );
  }
});

test("Responses encoder emits streamed text and terminal usage snapshot", () => {
  const encoder = new ResponsesStreamEncoder({
    responseId: "resp_text",
    model: "fixture-model",
    allowedTools: new Set(["exec_command"]),
    parallelToolCalls: true,
    createdAt: 1,
  });
  const events: Record<string, unknown>[] = encoder.start();
  assert.deepEqual(
    events.map((event) => event.type),
    ["response.created", "response.in_progress"],
  );
  for (const input of [
    { type: "text_start", id: "text-1" },
    { type: "text_delta", id: "text-1", text: "hello" },
    { type: "text_end", id: "text-1" },
  ] satisfies ModelStreamEvent[])
    events.push(...encoder.push(input));
  const terminal = encoder.finish({
    finishReason: "stop",
    usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
  });
  events.push(...terminal);
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_event, index) => index),
  );
  const first = events[0];
  assert.ok(first);
  assert.equal((first.response as { object: string }).object, "response");
  const complete = terminal.find((event) => event.type === "response.completed");
  assert.ok(complete);
  const response = complete.response as { output: unknown[]; usage: unknown };
  assert.equal(response.output.length, 1);
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 2, total_tokens: 9 });
  assert.equal(events.find((event) => event.type === "response.output_text.delta")?.delta, "hello");
});

test("Responses encoder keeps interleaved tool argument streams paired and supports multiple calls", () => {
  const encoder = new ResponsesStreamEncoder({
    responseId: "resp_tools",
    model: "fixture-model",
    allowedTools: new Set(["exec_command", "write_stdin"]),
    parallelToolCalls: true,
    createdAt: 1,
  });
  const events: Record<string, unknown>[] = encoder.start();
  const inputs: ModelStreamEvent[] = [
    { type: "tool_input_start", id: "call-1", toolName: "exec_command" },
    { type: "tool_input_start", id: "call-2", toolName: "write_stdin" },
    { type: "tool_input_delta", id: "call-1", delta: '{"cmd":' },
    { type: "tool_input_delta", id: "call-2", delta: '{"session_id":"s"}' },
    { type: "tool_input_delta", id: "call-1", delta: '"pwd"}' },
    { type: "tool_input_end", id: "call-1" },
    { type: "tool_call", toolCall: { id: "call-1", name: "exec_command", input: { cmd: "pwd" } } },
    { type: "tool_input_end", id: "call-2" },
    {
      type: "tool_call",
      toolCall: { id: "call-2", name: "write_stdin", input: { session_id: "s" } },
    },
    { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 11, outputTokens: 4 } },
  ];
  for (const input of inputs) {
    if (input.type === "finish") events.push(...encoder.finish(input));
    else events.push(...encoder.push(input));
  }
  const deltas = events.filter((event) => event.type === "response.function_call_arguments.delta");
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_event, index) => index),
  );
  assert.equal(new Set(deltas.map((event) => event.item_id)).size, 2);
  const outputItems = events
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => event.item as { call_id: string; name: string; arguments: string });
  assert.deepEqual(
    outputItems.map((item) => [item.call_id, item.name, JSON.parse(item.arguments)]),
    [
      ["call-1", "exec_command", { cmd: "pwd" }],
      ["call-2", "write_stdin", { session_id: "s" }],
    ],
  );
  assert.equal(events.at(-1)?.type, "response.completed");
});

test("Responses encoder maps length and rejects unsupported private reasoning", () => {
  const encoder = new ResponsesStreamEncoder({
    responseId: "resp_length",
    model: "fixture-model",
    allowedTools: new Set(),
    parallelToolCalls: true,
    createdAt: 1,
  });
  const started = encoder.start();
  const incomplete = encoder.finish({
    finishReason: "length",
    usage: { inputTokens: 1, outputTokens: 2 },
  });
  assert.equal(incomplete.at(-1)?.type, "response.incomplete");
  const response = incomplete.at(-1)?.response as {
    status: string;
    incomplete_details: { reason: string };
  };
  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal(started[0]?.sequence_number, 0);
  assert.equal(incomplete[0]?.sequence_number, 2);
  const reasoning = new ResponsesStreamEncoder({
    responseId: "resp_reasoning",
    model: "fixture-model",
    allowedTools: new Set(),
    parallelToolCalls: true,
    createdAt: 1,
  });
  reasoning.start();
  assert.throws(
    () => reasoning.push({ type: "reasoning_start", id: "private" }),
    ModelGatewayProtocolError,
  );
});
