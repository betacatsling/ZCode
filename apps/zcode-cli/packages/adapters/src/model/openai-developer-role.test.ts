import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
// Ajv 8.x 是纯 CommonJS：运行时 module.exports 既是 Ajv 类本身、又挂了 .Ajv/.default 属性；
// NodeNext 下默认导入在类型空间得到的是整个 CJS 模块命名空间（没有构造签名），
// 具名导入 { Ajv } 同时被 tsc 与真实 ESM 运行时（cjs-module-lexer 静态导出）正确解析。
import { Ajv } from "ajv";
import {
  ModelErrorCode,
  modelInputMessageJsonSchema,
  type ModelInputMessage,
} from "@zcode/contracts";
import { AiSdkModelAdapter, type CreateAiSdkModelOptions } from "./runner.js";
import {
  createOpenAiDeveloperRoleFetch,
  createOpenAiInstructionPlan,
  withOpenAiPromptCacheKey,
} from "./openai-developer-role.js";

const modelOptions = (baseUrl: string, type = "openai-responses"): CreateAiSdkModelOptions => ({
  providerId: "synthetic-provider",
  modelId: "synthetic-model",
  providerConfig: {
    access: { type: "api-key", apiKey: "synthetic-test-key" },
    api: { type, baseUrl },
  } as CreateAiSdkModelOptions["providerConfig"],
  modelConfig: {
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 8192,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["off"], map: "{}" },
      maxOutputTokens: { max: 1000, map: '{"max_output_tokens": maxOutputTokens}' },
    },
  } as unknown as CreateAiSdkModelOptions["modelConfig"],
  options: { reasoningLevel: "off", maxOutputTokens: 100 },
});

const messages = (...roles: Array<"system" | "developer">): ModelInputMessage[] => [
  ...roles.map((role, index) => ({ role, content: `synthetic instruction ${index}` })),
  { role: "user", content: "synthetic question" },
];

function successResponse(): string {
  return JSON.stringify({
    id: "resp_synthetic",
    model: "synthetic-model",
    created_at: 1760000000,
    output: [
      {
        type: "message",
        role: "assistant",
        id: "msg_synthetic",
        content: [{ type: "output_text", text: "synthetic answer", annotations: [] }],
      },
    ],
    usage: { input_tokens: 6, output_tokens: 2 },
  });
}

async function withFakeResponses<T>(
  respond: (
    body: Record<string, unknown>,
    headers: Record<string, string | string[] | undefined>,
    index: number,
  ) => { status: number; body: string; contentType?: string },
  run: (baseUrl: string, captured: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const captured: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    captured.push(body);
    try {
      const result = respond(body, request.headers, captured.length);
      response.writeHead(result.status, {
        "content-type": result.contentType ?? "application/json",
      });
      response.end(result.body);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error), type: "assertion_error" } }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await run(`http://127.0.0.1:${address.port}/v1`, captured);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const rolesInWire = (body: Record<string, unknown>): string[] =>
  (body.input as Array<{ role: string }>)
    .filter((entry) => entry.role === "system" || entry.role === "developer")
    .map((entry) => entry.role);

test("modelInputMessageJsonSchema accepts developer and refuses unknown roles", () => {
  const validate = new Ajv().compile(modelInputMessageJsonSchema);
  assert.equal(validate({ role: "developer", content: "policy" }), true);
  assert.equal(validate({ role: "owner", content: "policy" }), false);
  assert.equal(validate({ role: "developer", content: "policy", injected: true }), false);
});

test("OpenAI Responses adapter preserves concurrent opposite role plans, auth, options and native unchanged", async () => {
  await withFakeResponses(
    (body, headers) => {
      assert.equal(headers.authorization, "Bearer synthetic-test-key");
      assert.equal(body.model, "synthetic-model");
      assert.equal(body.max_output_tokens, 100);
      assert.equal(body.instructions, undefined);
      assert.equal(
        body.prompt_cache_key,
        rolesInWire(body).includes("developer") ? "synthetic-cache-key" : undefined,
      );
      return { status: 200, body: successResponse() };
    },
    async (baseUrl, captured) => {
      const model = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
        modelOptions(baseUrl),
      );
      const plans = [
        messages("system", "developer"),
        messages("developer", "system"),
        messages("system"),
      ];
      const results = await Promise.all(
        plans.map((plan) =>
          model.generateText({
            messages: plan,
            ...(plan.some((item) => item.role === "developer")
              ? { promptCacheKey: "synthetic-cache-key" }
              : {}),
          }),
        ),
      );
      assert.equal(results.length, 3);
      assert.deepEqual(
        results.map((result) => result.usage.inputTokens),
        [6, 6, 6],
      );
      assert.deepEqual(
        results.map((result) => result.usage.outputTokens),
        [2, 2, 2],
      );
      assert.deepEqual(
        captured.map(rolesInWire).sort(),
        [["system", "developer"], ["developer", "system"], ["system"]].sort(),
      );
      assert.deepEqual(captured.map((body) => (body.input as unknown[]).length).sort(), [2, 3, 3]);
    },
  );
});

test("OpenAI Responses retry gets the same source role plan on every SDK attempt", async () => {
  await withFakeResponses(
    (_body, _headers, index) =>
      index === 1
        ? {
            status: 503,
            body: JSON.stringify({ error: { message: "temporary", type: "server_error" } }),
          }
        : { status: 200, body: successResponse() },
    async (baseUrl, captured) => {
      const model = new AiSdkModelAdapter({
        retry: { maxAttempts: 2, baseDelayMs: 0, jitter: false },
      }).createModel(modelOptions(baseUrl));
      await model.generateText({ messages: messages("developer", "system", "developer") });
      assert.equal(captured.length, 2);
      assert.deepEqual(captured.map(rolesInWire), [
        ["developer", "system", "developer"],
        ["developer", "system", "developer"],
      ]);
    },
  );
});

test("unsupported provider and aborted request never send a request", async () => {
  await withFakeResponses(
    () => ({ status: 200, body: successResponse() }),
    async (baseUrl, captured) => {
      for (const type of ["anthropic-messages", "openai-chat-completions"]) {
        const model = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
          modelOptions(baseUrl, type),
        );
        await assert.rejects(
          model.generateText({ messages: messages("developer") }),
          /Developer messages require/,
        );
      }
      const model = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
        modelOptions(baseUrl),
      );
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        model.generateText({ messages: messages("developer"), abortSignal: abort.signal }),
      );
      for (const type of ["anthropic-messages", "openai-chat-completions"]) {
        const unsupported = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
          modelOptions(baseUrl, type),
        );
        await assert.rejects(
          unsupported.generateText({
            messages: [{ role: "user", content: "synthetic" }],
            promptCacheKey: "synthetic-cache-key",
          }),
          /Prompt cache key requires/,
        );
      }
      assert.equal(captured.length, 0);
    },
  );
});

test("typed prompt cache key refuses conflicts and malformed values", () => {
  assert.throws(
    () =>
      withOpenAiPromptCacheKey(
        { openai: { promptCacheKey: "other" } },
        "synthetic-cache-key",
        "openai",
      ),
    /conflicts/,
  );
  assert.throws(() => withOpenAiPromptCacheKey(undefined, "", "openai"), /non-empty/);
});

test("SDK instruction body tampering, extra instruction, and missing instruction fail before fetch", async () => {
  let sent = 0;
  const fetch = async () => {
    sent++;
    return new Response(successResponse());
  };
  const plan = createOpenAiInstructionPlan(messages("system", "developer"), "openai");
  assert.ok(plan);
  const guarded = createOpenAiDeveloperRoleFetch(fetch, plan);
  for (const input of [
    [
      { role: "system", content: "tampered" },
      { role: "system", content: "synthetic instruction 1" },
    ],
    [{ role: "system", content: "synthetic instruction 0" }],
    [
      { role: "system", content: "synthetic instruction 0" },
      { role: "system", content: "synthetic instruction 1" },
      { role: "system", content: "extra" },
    ],
  ]) {
    await assert.rejects(
      guarded("http://127.0.0.1/", { method: "POST", body: JSON.stringify({ input }) }),
      (error: { code?: string }) => error.code === ModelErrorCode.InvalidModelRequest,
    );
  }
  // 顶层 instructions 字段与多 system 计划冲突时必须在发 HTTP 前拒绝，不能让 SDK 偷偷改指令通道。
  await assert.rejects(
    guarded("http://127.0.0.1/", {
      method: "POST",
      body: JSON.stringify({
        instructions: "unexpected",
        input: [
          { role: "system", content: "synthetic instruction 0" },
          { role: "system", content: "synthetic instruction 1" },
        ],
      }),
    }),
    (error: { code?: string }) => error.code === ModelErrorCode.InvalidModelRequest,
  );
  assert.equal(sent, 0);
});

test("OpenAI Responses streaming restores instruction roles and reports SDK usage", async () => {
  const frame = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`;
  const body =
    [
      {
        type: "response.created",
        response: { id: "resp_stream", model: "synthetic-model", created_at: 1760000000 },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_stream" },
      },
      { type: "response.output_text.delta", item_id: "msg_stream", delta: "synthetic stream" },
      { type: "response.completed", response: { usage: { input_tokens: 8, output_tokens: 3 } } },
    ]
      .map(frame)
      .join("") + "data: [DONE]\n\n";
  await withFakeResponses(
    (request) => {
      assert.deepEqual(rolesInWire(request), ["system", "developer"]);
      assert.equal(request.prompt_cache_key, "synthetic-stream-cache");
      assert.equal(request.stream, true);
      return { status: 200, contentType: "text/event-stream", body };
    },
    async (baseUrl, captured) => {
      const model = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
        modelOptions(baseUrl),
      );
      const events = [];
      for await (const event of model.streamText({
        messages: messages("system", "developer"),
        promptCacheKey: "synthetic-stream-cache",
      }))
        events.push(event);
      assert.equal(captured.length, 1);
      assert.ok(
        events.some((event) => event.type === "text_delta" && event.text === "synthetic stream"),
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "finish" &&
            event.usage.inputTokens === 8 &&
            event.usage.outputTokens === 3,
        ),
      );
    },
  );
});
