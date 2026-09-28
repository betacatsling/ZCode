import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelRequest, ModelStreamEvent } from "@zcode/contracts";
import { decodeMessagesRequest, parsePinnedAnthropicBetaHeader } from "../src/model-gateway/domain/messagesDecoder.js";
import { MessagesStreamEncoder } from "../src/model-gateway/domain/messagesStreamEncoder.js";
import { ModelGatewayProtocolError } from "../src/model-gateway/domain/errors.js";
import { createModelGateway } from "../src/model-gateway/index.js";

const betas = [
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "effort-2025-11-24",
].join(",");

function decoderModel(): Model {
  return {
    providerId: "fixture-provider",
    modelId: "fixture-model",
    properties: { contextWindow: 4096 },
    optionSpecs: { maxOutputTokens: { max: 4096 } },
    options: { reasoningLevel: "low" },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("Messages fixture uses streamText only");
    },
    async *streamText() {
      yield { type: "start", usage: { inputTokens: 5, outputTokens: 0 } };
      yield { type: "text_start", id: "fixture-text" };
      yield { type: "text_delta", id: "fixture-text", text: "fixture" };
      yield { type: "text_end", id: "fixture-text" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
      };
    },
  } as unknown as Model;
}

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    max_tokens: 8,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    metadata: { user_id: "fixture-user" },
    model: "zcode-host",
    output_config: { effort: "low" },
    stream: true,
    system: [{ type: "text", text: "system instruction" }],
    tools: [
      {
        name: "Bash",
        description: "run a command",
        input_schema: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    ...overrides,
  };
}

test("Messages decoder preserves system, ordered tool batches and paired tool results", () => {
  const request = decodeMessagesRequest(
    requestBody({
      messages: [
        { role: "user", content: [{ type: "text", text: "question" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "toolu-a", name: "Bash", input: { command: "printf a" } },
            { type: "tool_use", id: "toolu-b", name: "Bash", input: { command: "printf b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu-a", content: [{ type: "text", text: "a" }] },
            { type: "tool_result", tool_use_id: "toolu-b", content: "b", is_error: true },
          ],
        },
        { role: "system", content: [{ type: "text", text: "mid-turn system" }] },
      ],
    }),
    "zcode-host",
    decoderModel(),
    parsePinnedAnthropicBetaHeader(betas)!,
  );
  assert.equal(request.systemInstructions, "system instruction");
  assert.equal(request.effort, "low");
  assert.equal(request.maxOutputTokens, 8);
  assert.equal(request.messages[0]?.role, "user");
  assert.equal(request.messages[1]?.role, "assistant");
  assert.equal(request.messages[1]?.content, "checking");
  assert.deepEqual(request.messages[1]?.toolCalls?.map((call) => call.id), ["toolu-a", "toolu-b"]);
  assert.equal(request.messages[2]?.role, "tool");
  assert.equal(request.messages[2]?.toolCallId, "toolu-a");
  assert.equal(request.messages[3]?.toolCallId, "toolu-b");
  assert.equal(request.messages[3]?.isError, true);
  assert.equal(request.messages[4]?.role, "system");
});

test("Messages decoder fails closed for unrepresentable or unsupported request semantics", () => {
  const expectedModel = "zcode-host";
  const model = decoderModel();
  const supportedBetas = parsePinnedAnthropicBetaHeader(betas)!;
  const reject = (body: Record<string, unknown>, error: string) =>
    assert.throws(
      () => decodeMessagesRequest(body, expectedModel, model, supportedBetas),
      (cause: unknown) => cause instanceof ModelGatewayProtocolError && cause.message.includes(error),
    );

  assert.equal(parsePinnedAnthropicBetaHeader(`${betas},unknown-beta`), undefined);
  reject(requestBody({ model: "other-model" }), "model does not match");
  reject(requestBody({ thinking: { type: "adaptive" } }), "thinking");
  reject(requestBody({ temperature: 1 }), "temperature");
  reject(
    requestBody({ messages: [{ role: "developer", content: "must not flatten" }] }),
    "developer",
  );
  reject(
    requestBody({ messages: [{ role: "user", content: [{ type: "image", source: {} }] }] }),
    "type is not supported",
  );
  reject(
    requestBody({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "x" }] }] }),
    "unmatched tool_use",
  );
  reject(
    requestBody({ output_config: { effort: "high" } }),
    "differs from the frozen Model binding",
  );
});

test("Messages encoder emits complete Anthropic blocks and replacement usage snapshots", () => {
  const encoder = new MessagesStreamEncoder({
    responseId: "msg_fixture",
    model: "zcode-host",
    allowedTools: new Set(["Bash"]),
    maxArgumentBytes: 4096,
    maxOutputTokens: 64,
    startUsage: { inputTokens: 5, outputTokens: 0 },
  });
  const output = encoder.start();
  output.push(
    ...encoder.push({ type: "text_start", id: "text-1" }),
    ...encoder.push({ type: "text_delta", id: "text-1", text: "run tools" }),
    ...encoder.push({ type: "text_end", id: "text-1" }),
    ...encoder.push({ type: "tool_input_start", id: "tool-1", toolName: "Bash" }),
    ...encoder.push({ type: "tool_input_delta", id: "tool-1", delta: '{"command":"printf a"}' }),
    ...encoder.push({ type: "tool_input_end", id: "tool-1" }),
    ...encoder.push({
      type: "tool_call",
      toolCall: { id: "tool-1", name: "Bash", input: { command: "printf a" } },
    }),
    ...encoder.push({ type: "tool_input_start", id: "tool-2", toolName: "Bash" }),
    ...encoder.push({ type: "tool_input_delta", id: "tool-2", delta: '{"command":"printf b"}' }),
    ...encoder.push({ type: "tool_input_end", id: "tool-2" }),
  );
  output.push(
    ...encoder.finish({
      type: "finish",
      finishReason: "tool-calls",
      usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 },
    }),
  );
  assert.equal(output[0]?.type, "message_start");
  assert.deepEqual(
    (output[0]?.message as { usage: unknown }).usage,
    { input_tokens: 5, output_tokens: 0 },
  );
  assert.equal(output.filter((event) => event.type === "content_block_start").length, 3);
  assert.equal(output.at(-2)?.type, "message_delta");
  assert.deepEqual((output.at(-2)?.usage as Record<string, unknown>), {
    input_tokens: 7,
    output_tokens: 9,
  });
  assert.deepEqual((output.at(-2)?.delta as Record<string, unknown>).stop_reason, "tool_use");
  assert.equal(output.at(-1)?.type, "message_stop");
});

test("Messages encoder refuses unsigned reasoning and unsupported finish reasons", () => {
  const create = () =>
    new MessagesStreamEncoder({
      responseId: "msg_fixture",
      model: "zcode-host",
      allowedTools: new Set(),
      maxArgumentBytes: 1024,
      maxOutputTokens: 16,
      startUsage: { inputTokens: 1, outputTokens: 0 },
    });
  const reasoning = create();
  reasoning.start();
  assert.throws(
    () => reasoning.push({ type: "reasoning_delta", text: "private" }),
    /unsigned Messages thinking/,
  );
  const finish = create();
  finish.start();
  assert.throws(
    () =>
      finish.finish({
        type: "finish",
        finishReason: "content-filter",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    /finish reason is not supported/,
  );
});

test("Messages HTTP route binds x-api-key to its protocol, model, budget and abort signal", async (t) => {
  let calls = 0;
  let aborts = 0;
  let abortObserved!: () => void;
  const abortPromise = new Promise<void>((resolve) => {
    abortObserved = resolve;
  });
  const model: Model = {
    ...decoderModel(),
    async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      calls += 1;
      assert.equal(request.options?.reasoningLevel, "low");
      assert.equal(request.abortSignal instanceof AbortSignal, true);
      yield { type: "start", usage: { inputTokens: 5, outputTokens: 0 } };
      if (request.messages.some((message) => message.content === "WAIT_FOR_ABORT")) {
        try {
          await new Promise<void>((resolve) =>
            request.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        } finally {
          if (request.abortSignal?.aborted) {
            aborts += 1;
            abortObserved();
          }
        }
        return;
      }
      yield { type: "text_start", id: `text-${calls}` };
      yield { type: "text_delta", id: `text-${calls}`, text: "fixture reply" };
      yield { type: "text_end", id: `text-${calls}` };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 },
      };
    },
  };
  const gateway = createModelGateway({
    targetId: "target-messages-test",
    host: "127.0.0.1",
    port: 0,
    maxConcurrent: 4,
  });
  const { baseUrl } = await gateway.start();
  const grant = gateway.createGrant({
    protocol: "anthropic-messages",
    sessionId: "messages-session",
    modelBindingFingerprint: "messages-binding-v1",
    publicModelId: "zcode-host",
    model,
    expiresInMs: 60_000,
    limits: {
      maxBodyBytes: 8192,
      maxRequests: 8,
      maxConcurrent: 2,
      maxOutputTokens: 32,
      maxOutputTokensPerRequest: 8,
    },
  });
  t.after(() => gateway.close());
  const url = `${baseUrl}/v1/messages?beta=true`;
  const headers = {
    "content-type": "application/json",
    "x-api-key": grant.token,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": betas,
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const post = (body: unknown, overrideHeaders: Record<string, string> = headers, signal?: AbortSignal) =>
    fetch(url, { method: "POST", headers: overrideHeaders, body: JSON.stringify(body), signal });

  const hello = await fetch(`${baseUrl}/api/hello`, { method: "HEAD" });
  assert.equal(hello.status, 200);
  const missingAuth = await post(requestBody(), { ...headers, "x-api-key": "wrong" });
  assert.equal(missingAuth.status, 401);
  const wrongModel = await post(requestBody({ model: "other-model" }));
  assert.equal(wrongModel.status, 400);
  const unsupported = await post(requestBody({ temperature: 1 }));
  assert.equal(unsupported.status, 400);
  assert.equal(calls, 0, "rejected route/body must not call the bound Model");

  const responsesModel = {
    ...model,
    options: { reasoningLevel: "off" },
  } as Model;
  const responsesGrant = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: "responses-session",
    modelBindingFingerprint: "responses-binding-v1",
    publicModelId: "responses-model",
    model: responsesModel,
    expiresInMs: 60_000,
    limits: {
      maxBodyBytes: 4096,
      maxRequests: 2,
      maxConcurrent: 1,
      maxOutputTokens: 16,
      maxOutputTokensPerRequest: 8,
    },
  });
  const messagesWithResponsesToken = await post(requestBody(), {
    ...headers,
    "x-api-key": responsesGrant.token,
  });
  assert.equal(messagesWithResponsesToken.status, 401);
  const responsesWithMessagesToken = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${grant.token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(responsesWithMessagesToken.status, 401);

  const response = await post(requestBody());
  assert.equal(response.status, 200);
  const events = await readSseEvents(response);
  assert.equal(events[0]?.type, "message_start");
  assert.deepEqual((events[0]?.message as { usage: unknown }).usage, {
    input_tokens: 5,
    output_tokens: 0,
  });
  const terminal = events.find((event) => event.type === "message_delta");
  assert.ok(terminal);
  assert.deepEqual(terminal.usage, { input_tokens: 6, output_tokens: 3 });
  assert.equal((terminal.delta as Record<string, unknown>).stop_reason, "end_turn");

  const abort = new AbortController();
  const pendingResponse = await post(
    requestBody({ messages: [{ role: "user", content: "WAIT_FOR_ABORT" }] }),
    headers,
    abort.signal,
  );
  assert.equal(pendingResponse.status, 200);
  const reader = pendingResponse.body!.getReader();
  await reader.read();
  abort.abort();
  await assert.rejects(() => reader.read());
  await abortPromise;
  assert.equal(aborts, 1);
});

async function readSseEvents(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((record) => JSON.parse(record.slice(record.indexOf("data: ") + 6)) as Record<string, unknown>);
}
