import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import {
  ApiKeyAccessConfig,
  EnumOptionSpecConfig,
  LimitOptionSpecConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
} from "@zcode/provider";

function modelConfig(reasoningLevel: string, reasoningMap: string): ModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 16_000,
      inputFormat: new ModelInputFormatConfig({ supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: new EnumOptionSpecConfig({ values: [reasoningLevel], map: reasoningMap }),
      maxOutputTokens: new LimitOptionSpecConfig({ max: 128, map: "{\"max_tokens\": maxOutputTokens}" }),
    }),
  });
}

async function collect(model: ReturnType<AiSdkModelAdapter["createModel"]>): Promise<void> {
  for await (const _event of model.streamText({ messages: [{ role: "user", content: "hello" }], options: { reasoningLevel: model.options.reasoningLevel, maxOutputTokens: 32 } })) { /* consume */ }
}

test("fake HTTP asserts StepFun low reasoning mapping and Anthropic disabled thinking headers", async () => {
  const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ path: request.url ?? "", headers: request.headers, body });
      if (request.url?.endsWith("/messages")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        emit("message_start", { type: "message_start", message: { id: "msg-1", type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        emit("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        emit("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
        emit("content_block_stop", { type: "content_block_stop", index: 0 });
        emit("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
        emit("message_stop", { type: "message_stop" });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const stepProvider = new ProviderConfig({ access: new ApiKeyAccessConfig({ apiKey: "fixture-step-key" }), api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` }) });
    const stepAdapter = new AiSdkModelAdapter({ streamIdleTimeoutMs: 5_000 });
    await collect(stepAdapter.createModel({ providerId: "stepfun", modelId: "step-3.5-flash", providerConfig: stepProvider as never, modelConfig: modelConfig("low", "{\"reasoning_effort\": \"low\"}") as never, options: { reasoningLevel: "low" } }));
    const axonProvider = new ProviderConfig({ access: new ApiKeyAccessConfig({ apiKey: "fixture-axon-key" }), api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}/v1`, headers: { "x-axonhub-auth-mode": "api-key" } }) });
    const axonAdapter = new AiSdkModelAdapter({ streamIdleTimeoutMs: 5_000 });
    await collect(axonAdapter.createModel({ providerId: "axonhub", modelId: "deepseek-v4-flash", providerConfig: axonProvider as never, modelConfig: modelConfig("off", "{\"thinking\": {\"type\": \"disabled\"}}") as never, options: { reasoningLevel: "off" } }));
    assert.equal(requests.length, 2);
    const stepRequest = requests.find((request) => request.path?.endsWith("/chat/completions"));
    assert.equal(stepRequest?.body.reasoning_effort, "low");
    assert.equal(stepRequest?.headers.authorization, "Bearer fixture-step-key");
    const axonRequest = requests.find((request) => request.path?.endsWith("/messages"));
    assert.deepEqual(axonRequest?.body.thinking, { type: "disabled" });
    assert.equal(axonRequest?.headers["x-api-key"], "fixture-axon-key");
    assert.equal(axonRequest?.headers["x-axonhub-auth-mode"], "api-key");
  } finally {
    server.close();
    await once(server, "close");
  }
});
