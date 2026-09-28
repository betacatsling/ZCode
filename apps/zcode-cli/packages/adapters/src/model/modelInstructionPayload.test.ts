import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { ModelExecutionRequest } from "./model.js";
import { createModel } from "./model.js";
import { instructionProviderOptions } from "./runner-instruction-options.js";
import { toAiSdkMessages } from "./transform.js";

test("executable Model preserves the optional system instruction layer for existing runtimes", async () => {
  let observed: ModelExecutionRequest | undefined;
  const model = createModel({
    providerId: "fixture-provider" as never,
    modelId: "fixture-model" as never,
    properties: {
      contextWindow: 2048,
      inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsMidConversationSystem: true,
    } as never,
    optionSpecs: {
      reasoningLevel: { values: ["off"] },
      maxOutputTokens: { max: 16 },
    } as never,
    options: { reasoningLevel: "off", maxOutputTokens: 8 },
    executor: {
      async generateText() { throw new Error("not used"); },
      async *streamText(request) {
        observed = request;
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  for await (const _event of model.streamText({ messages: [], systemInstructions: "system layer" })) { /* consume */ }
  assert.equal(observed?.systemInstructions, "system layer");
});

test("OpenAI Responses provider payload keeps instructions and developer input in separate layers", async () => {
  let requestUrl = "";
  let payload: Record<string, unknown> | undefined;
  const openai = createOpenAI({
    apiKey: "fixture-only",
    baseURL: "http://127.0.0.1:9/v1",
    fetch: async (input, init) => {
      requestUrl = String(input);
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "resp_fixture",
          object: "response",
          created_at: 1,
          status: "completed",
          error: null,
          incomplete_details: null,
          model: "fixture-model",
          output: [
            {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          parallel_tool_calls: true,
          tool_choice: "auto",
          tools: [],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const providerOptions = instructionProviderOptions(
    {
      messages: [
        { role: "developer", content: "Developer policy" },
        { role: "user", content: "User request" },
      ],
      systemInstructions: "System policy",
    },
    { providerKind: "openai", providerOptions: { apiFormat: "openai-responses" } },
  );
  await generateText({
    allowSystemInMessages: true,
    model: openai.responses("fixture-model"),
    messages: toAiSdkMessages(
      [
        { role: "developer", content: "Developer policy" },
        { role: "user", content: "User request" },
      ],
      { providerKind: "openai", apiFormat: "openai-responses" },
    ),
    providerOptions,
  });

  assert.equal(requestUrl, "http://127.0.0.1:9/v1/responses");
  assert.equal(payload?.instructions, "System policy");
  assert.deepEqual(payload?.input, [
    { role: "developer", content: "Developer policy" },
    { role: "user", content: [{ type: "input_text", text: "User request" }] },
  ]);
});

test("OpenAI Responses provider payload keeps visible assistant text with its tool-call batch and paired outputs", async () => {
  let payload: Record<string, unknown> | undefined;
  const openai = createOpenAI({
    apiKey: "fixture-only",
    baseURL: "http://127.0.0.1:9/v1",
    fetch: async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "resp_tool_fixture",
        object: "response",
        created_at: 1,
        status: "completed",
        error: null,
        incomplete_details: null,
        model: "fixture-model",
        output: [{ id: "msg_tool_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }],
        parallel_tool_calls: true,
        tool_choice: "auto",
        tools: [],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await generateText({
    model: openai.responses("fixture-model"),
    messages: toAiSdkMessages([
      { role: "user", content: "Run two fixture operations." },
      {
        role: "assistant",
        content: "I will run both operations.",
        toolCalls: [
          { id: "call-a", name: "exec_command", input: { cmd: "printf a" } },
          { id: "call-b", name: "exec_command", input: { cmd: "printf b" } },
        ],
      },
      { role: "tool", content: "a", toolCallId: "call-a", toolName: "exec_command" },
      { role: "tool", content: "b", toolCallId: "call-b", toolName: "exec_command" },
      { role: "user", content: "Continue." },
    ], { providerKind: "openai", apiFormat: "openai-responses" }),
  });

  const input = payload?.input;
  assert.ok(Array.isArray(input));
  const items = input as Array<Record<string, unknown>>;
  assert.match(JSON.stringify(items), /I will run both operations\./);
  const calls = items.filter((item) => item.type === "function_call");
  assert.deepEqual(calls.map((item) => item.call_id), ["call-a", "call-b"]);
  const outputs = items.filter((item) => item.type === "function_call_output");
  assert.deepEqual(outputs.map((item) => [item.call_id, item.output]), [["call-a", "a"], ["call-b", "b"]]);
});

test("developer/system instruction layers fail closed on providers without Responses semantics", () => {
  assert.throws(
    () => instructionProviderOptions(
      { messages: [{ role: "developer", content: "Developer policy" }], systemInstructions: "System policy" },
      { providerKind: "openai-compatible", providerOptions: { apiFormat: "openai-chat-completions" } },
    ),
    /System\/developer instruction layers require the OpenAI Responses provider/,
  );
  assert.throws(
    () => toAiSdkMessages(
      [{ role: "developer", content: "Developer policy" }],
      { providerKind: "openai", apiFormat: "openai-chat-completions" },
    ),
    /Developer-priority messages require the OpenAI Responses provider/,
  );
});
