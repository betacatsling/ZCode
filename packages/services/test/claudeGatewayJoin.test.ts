import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AiSdkModelAdapter,
  toAiSdkMessages,
  type CreateAiSdkModelOptions,
} from "@zcode/adapters/model";
import { modelRequestJsonSchema } from "@zcode/contracts";
import { z } from "zod";
import { ClaudeCodeTransport } from "../src/agent-adapters/claude-code/claudeTransport.js";
import { createModelGateway } from "../src/model-gateway/gateway.js";
import { anthropicMessagesProtocol } from "../src/model-gateway/ingress/anthropicMessages.js";

const alias = "claude-sonnet-4-6";
function fixtureModel(
  baseUrl: string,
  baseDir: string,
  reasoningMap = "{}",
): ReturnType<AiSdkModelAdapter["createModel"]> {
  const input = {
    providerId: "fixture-anthropic",
    modelId: alias,
    providerConfig: {
      access: { type: "api-key", apiKey: "fixture-only" },
      api: { type: "anthropic-messages", baseUrl },
    },
    modelConfig: {
      properties: {
        contextWindow: 8192,
        requiresMfjsToolSchema: false,
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
        reasoningLevel: { values: ["off"], map: reasoningMap },
        maxOutputTokens: { max: 1024, map: '{"max_tokens": maxOutputTokens}' },
      },
    },
    options: { reasoningLevel: "off", maxOutputTokens: 128 },
  } as CreateAiSdkModelOptions;
  return new AiSdkModelAdapter({
    retry: { maxAttempts: 1 },
    env: { ZCODE_DATA_BASE_DIR: baseDir },
  }).createModel(input);
}
function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}
function completion(model: string, first: boolean): string {
  const start = sse("message_start", {
    message: {
      id: `msg_fixture_${first ? 1 : 2}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        output_tokens: 0,
      },
    },
  });
  const content = first
    ? [
        sse("content_block_start", {
          index: 0,
          content_block: { type: "tool_use", id: "toolu_fixture", name: "Edit", input: {} },
        }),
        sse("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"fixture"}' },
        }),
      ]
    : [
        sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }),
      ];
  return (
    start +
    content.join("") +
    sse("content_block_stop", { index: 0 }) +
    sse("message_delta", {
      delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }) +
    sse("message_stop", {})
  );
}
function frames(body: string): Array<Record<string, unknown>> {
  return body.split("\n\n").flatMap((chunk) => {
    const data = chunk.split("\n").find((line) => line.startsWith("data: "));
    return data ? [JSON.parse(data.slice(6)) as Record<string, unknown>] : [];
  });
}

test("Messages Gateway -> existing Anthropic Model -> fake upstream retains per-part cache, metadata, effort across two tool requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-join-"));
  const upstreamBodies: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    upstreamBodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(completion(String(body.model), upstreamBodies.length === 1));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;
  const model = fixtureModel(`http://127.0.0.1:${upstreamPort}`, root);
  const gateway = createModelGateway({
    protocols: [anthropicMessagesProtocol],
    resolveModel: () => model,
    limits: { maxBodyBytes: 256 * 1024, maxConcurrentRequests: 1 },
  });
  const { url } = await gateway.start();
  const issue = (turnId: string) =>
    gateway.issueToken({
      targetId: "target",
      hostSessionId: "session",
      runtimeEpoch: "epoch",
      turnId,
      protocol: "anthropic-messages",
      requestedModelAlias: alias,
      effectiveSelection: {
        providerId: "fixture-anthropic",
        modelId: alias,
        options: { reasoningLevel: "off" },
      },
      expiresAt: Date.now() + 30_000,
      maxRequests: 1,
      maxOutputBytes: 64 * 1024,
      maxGenerationTokens: 256,
      maxOutputTokensPerRequest: 128,
    });
  const send = async (turn: string, messages: unknown[]) => {
    const token = await issue(turn);
    try {
      const response = await fetch(`${url}/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          "x-api-key": token,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: alias,
          stream: true,
          max_tokens: 128,
          temperature: 1,
          metadata: { user_id: "opaque-fixture-id" },
          output_config: { effort: "high" },
          messages,
          tools: [{ name: "Edit", input_schema: { type: "object" } }],
        }),
      });
      const raw = await response.text();
      assert.equal(response.status, 200, raw.slice(0, 180));
      return frames(raw);
    } finally {
      gateway.revokeToken(token);
    }
  };
  try {
    const user = {
      role: "user",
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
        { type: "text", text: "three", cache_control: { type: "ephemeral" } },
      ],
    };
    const first = await send("first", [user]);
    const firstDelta = first.find((frame) => frame.type === "message_delta");
    assert.ok(firstDelta, JSON.stringify(first));
    assert.equal((firstDelta.delta as { stop_reason: string }).stop_reason, "tool_use");
    assert.deepEqual(firstDelta.usage, {
      input_tokens: 4,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    });
    const call = first.find((frame) => frame.type === "content_block_start")?.content_block as {
      id: string;
      name: string;
    };
    assert.equal(call.name, "Edit");
    const second = await send("second", [
      user,
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: call.id, name: call.name, input: { file_path: "fixture" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            is_error: true,
            content: "denied",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    assert.equal(second.at(-1)?.type, "message_stop");
    assert.deepEqual(second.find((frame) => frame.type === "message_delta")?.usage, {
      input_tokens: 4,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    });
    assert.equal(upstreamBodies.length, 2);
    for (const body of upstreamBodies) {
      assert.equal(body.temperature, 1);
      // @ai-sdk/anthropic omits thinking when neither enabled nor adaptive is selected.
      assert.equal(body.thinking, undefined);
      assert.deepEqual(body.output_config, { effort: "high" });
      assert.deepEqual(body.metadata, { user_id: "opaque-fixture-id" });
      const userContent = (
        body.messages as Array<{ role: string; content: Array<{ cache_control?: unknown }> }>
      )[0]?.content;
      assert.equal(userContent?.length, 3);
      assert.deepEqual(
        userContent?.map((part) => part.cache_control ?? null),
        [null, null, { type: "ephemeral" }],
      );
    }
    const toolResult = (
      upstreamBodies[1]!.messages as Array<{ content: Array<{ cache_control?: unknown }> }>
    ).at(-1)?.content;
    assert.deepEqual(toolResult?.[0]?.cache_control, { type: "ephemeral" });
  } finally {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("strict ModelRequest schema validates actual Gateway boundary, excluding runtime fields", async () => {
  const schema = z.fromJSONSchema(modelRequestJsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
  assert.equal(
    schema.safeParse({ messages: [{ role: "user", content: "fixture" }], abortSignal: {} }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      messages: [{ role: "user", content: "fixture" }],
      providerOptions: { arbitrary: 1 },
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "fixture", cacheControl: { type: "ephemeral" } }],
        },
      ],
      anthropicEffort: "high",
      options: { maxOutputTokens: 128 },
    }).success,
    true,
  );
  let calls = 0;
  const model = {
    providerId: "fixture-anthropic",
    modelId: alias,
    options: { reasoningLevel: "off" },
    async *streamText() {
      calls++;
      yield { type: "start" };
    },
  } as unknown as ReturnType<AiSdkModelAdapter["createModel"]>;
  const badProtocol = {
    ...anthropicMessagesProtocol,
    decode: () => ({
      modelId: alias,
      stream: true as const,
      request: {
        messages: [{ role: "user", content: "fixture" }],
        unexpected: "injected",
      } as never,
    }),
  };
  const gateway = createModelGateway({
    protocols: [badProtocol],
    resolveModel: () => model,
    limits: { maxBodyBytes: 1024, maxConcurrentRequests: 1 },
  });
  const { url } = await gateway.start();
  try {
    const token = await gateway.issueToken({
      targetId: "target",
      hostSessionId: "session",
      runtimeEpoch: "epoch",
      turnId: "turn",
      protocol: "anthropic-messages",
      requestedModelAlias: alias,
      effectiveSelection: {
        providerId: "fixture-anthropic",
        modelId: alias,
        options: { reasoningLevel: "off" },
      },
      expiresAt: Date.now() + 30_000,
      maxRequests: 1,
      maxOutputBytes: 1024,
      maxGenerationTokens: 128,
      maxOutputTokensPerRequest: 128,
    });
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: { code: "invalid_model_request" } });
    assert.equal(calls, 0);
  } finally {
    await gateway.close();
  }
});

test("pinned Claude SDK request reaches Gateway but unsupported semantic beta headers fail before Model or Edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-native-gate-"));
  const cwd = join(root, "workspace");
  const profileDir = join(root, "profile");
  await mkdir(cwd);
  await mkdir(profileDir);
  const marker = join(cwd, "marker");
  await writeFile(marker, "original\n");
  let calls = 0;
  const rejected: string[] = [];
  const model = {
    providerId: "fixture-anthropic",
    modelId: alias,
    options: { reasoningLevel: "off" },
    async *streamText() {
      calls++;
      yield { type: "start" };
    },
  } as unknown as ReturnType<AiSdkModelAdapter["createModel"]>;
  const gateway = createModelGateway({
    protocols: [anthropicMessagesProtocol],
    resolveModel: () => model,
    observe: (event) => rejected.push(event.code),
    limits: { maxBodyBytes: 256 * 1024, maxConcurrentRequests: 1 },
  });
  const { url } = await gateway.start();
  try {
    const token = await gateway.issueToken({
      targetId: "target",
      hostSessionId: "session",
      runtimeEpoch: "epoch",
      turnId: "turn",
      protocol: "anthropic-messages",
      requestedModelAlias: alias,
      effectiveSelection: {
        providerId: "fixture-anthropic",
        modelId: alias,
        options: { reasoningLevel: "off" },
      },
      expiresAt: Date.now() + 30_000,
      maxRequests: 2,
      maxOutputBytes: 64 * 1024,
      maxGenerationTokens: 256,
      maxOutputTokensPerRequest: 128,
    });
    const transport = new ClaudeCodeTransport({
      cwd,
      profileDir,
      gatewayUrl: url,
      gatewayToken: token,
      model: alias,
    });
    const watchdog = setTimeout(() => transport.cancel(), 12_000);
    try {
      await assert.rejects(
        transport.run("Edit marker from original to changed.", (event) => {
          if (event.type === "permission") assert.fail("unsupported beta must not reach execution");
        }),
        /claude_result_error|claude_sdk_failure|claude_cancelled/,
      );
      assert.ok(rejected.includes("unsupported_beta"), JSON.stringify(rejected));
      assert.equal(calls, 0);
      assert.equal(await readFile(marker, "utf8"), "original\n");
    } finally {
      clearTimeout(watchdog);
      gateway.revokeToken(token);
    }
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Anthropic cache marker validation refuses conflicting, excess and unsupported provider boundaries", () => {
  const options = { providerKind: "anthropic" as const };
  const mark = { type: "ephemeral" as const };
  assert.throws(
    () =>
      toAiSdkMessages(
        [
          {
            role: "user",
            cacheControl: mark,
            content: [{ type: "text", text: "fixture", cacheControl: mark }],
          },
        ],
        options,
      ),
    /Conflicting/,
  );
  assert.throws(
    () =>
      toAiSdkMessages(
        [
          {
            role: "user",
            content: Array.from({ length: 5 }, (_, n) => ({
              type: "text" as const,
              text: `fixture-${n}`,
              cacheControl: mark,
            })),
          },
        ],
        options,
      ),
    /breakpoint/,
  );
  assert.throws(
    () =>
      toAiSdkMessages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: "fixture", cacheControl: { type: "ephemeral", scope: "org" } },
            ],
          },
        ],
        options,
      ),
    /Unsupported/,
  );
  assert.throws(
    () =>
      toAiSdkMessages(
        [{ role: "user", content: [{ type: "text", text: "fixture", cacheControl: mark }] }],
        { providerKind: "openai" },
      ),
    /requires Anthropic/,
  );
});

test("Gateway rejects disabled-thinking request against captured high binding before Model IO", async () => {
  let calls = 0;
  const model = {
    providerId: "fixture-anthropic", modelId: alias, options: { reasoningLevel: "high" },
    async *streamText() { calls++; yield { type: "start" }; },
  } as unknown as ReturnType<AiSdkModelAdapter["createModel"]>;
  const gateway = createModelGateway({ protocols: [anthropicMessagesProtocol], resolveModel: () => model,
    limits: { maxBodyBytes: 2048, maxConcurrentRequests: 1 } });
  const { url } = await gateway.start();
  try {
    const token = await gateway.issueToken({ targetId: "target", hostSessionId: "session", runtimeEpoch: "epoch", turnId: "turn",
      protocol: "anthropic-messages", requestedModelAlias: alias,
      effectiveSelection: { providerId: model.providerId, modelId: model.modelId, options: { reasoningLevel: "high" } },
      expiresAt: Date.now() + 30_000, maxRequests: 1, maxOutputBytes: 1024,
      maxGenerationTokens: 128, maxOutputTokensPerRequest: 128 });
    const response = await fetch(`${url}/v1/messages`, { method: "POST", headers: {
      "x-api-key": token, "anthropic-version": "2023-06-01", "content-type": "application/json",
    }, body: JSON.stringify({ model: alias, max_tokens: 128, stream: true,
      messages: [{ role: "user", content: "fixture" }], thinking: { type: "disabled" } }) });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: { code: "model_options_mismatch" } });
    assert.equal(calls, 0);
  } finally { await gateway.close(); }
});

test("Anthropic frozen off rejects option map injecting enabled thinking before upstream IO", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-thinking-"));
  let calls = 0;
  const upstream = createServer((_req, res) => { calls++; res.writeHead(500).end(); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    for (const map of ['{"thinking":{"type":"enabled","budget_tokens":1024}}',
      '{"thinking":{"type":"disabled","budget_tokens":1024}}']) {
      const model = fixtureModel(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        root, map);
      await assert.rejects(async () => {
        for await (const _event of model.streamText({ messages: [{ role: "user", content: "fixture" }],
          options: { reasoningLevel: "off" } })) { /* reject before stream */ }
      });
    }
    assert.equal(calls, 0);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Anthropic native effort conflicting with frozen reasoning map fails before upstream request", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-conflict-"));
  let calls = 0;
  const upstream = createServer((_req, res) => {
    calls++;
    res.writeHead(500).end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    const model = fixtureModel(
      `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      root,
      '{"output_config":{"effort":"low"}}',
    );
    for await (const _event of model.streamText({
      messages: [{ role: "user", content: "fixture" }],
      anthropicEffort: "high",
    })) {
      /* fail before stream */
    }
    assert.fail("expected native conflict");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(calls, 0);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
