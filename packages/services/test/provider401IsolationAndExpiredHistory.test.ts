import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ModelNetworkStatusEvent } from "@zcode/contracts";
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
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { createAgentHostConversationBridge } from "../src/agent-host/conversationBridge.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

function modelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 16_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: new EnumOptionSpecConfig({
        values: ["off"],
        map: '{"reasoning_effort": "none"}',
      }),
      maxOutputTokens: new LimitOptionSpecConfig({
        max: 128,
        map: '{"max_tokens": maxOutputTokens}',
      }),
    }),
  });
}

function providerConfig(baseUrl: string, apiKey: string): ProviderConfig {
  return new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
  });
}

async function collect(model: ReturnType<AiSdkModelAdapter["createModel"]>): Promise<void> {
  for await (const _event of model.streamText({
    messages: [{ role: "user", content: "hello" }],
    options: { reasoningLevel: "off", maxOutputTokens: 32 },
  })) {
    // Consume the entire stream so provider failures and completion statuses are observed.
  }
}

test("Provider 401 is scoped to A while B/C remain usable sequentially and concurrently", async () => {
  const requests: Array<{ route: string; authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    const route = request.url?.includes("/provider-a/")
      ? "provider-a"
      : request.url?.includes("/provider-b/")
        ? "provider-b"
        : "provider-c";
    requests.push({ route, authorization: request.headers.authorization });
    if (route === "provider-a") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "expired personal key", type: "auth_error" } }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: `ok-${route}` }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.write("data: [DONE]\n\n");
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const keys = new Map([
    ["provider-a", "key-a"],
    ["provider-b", "key-b"],
    ["provider-c", "key-c"],
  ]);
  const keySnapshot = [...keys.entries()];
  const statuses: ModelNetworkStatusEvent[] = [];
  const adapter = new AiSdkModelAdapter({
    streamIdleTimeoutMs: 5_000,
    statusSink: { publish: (event) => statuses.push(event) },
  });
  const makeModel = (providerId: string) =>
    adapter.createModel({
      providerId,
      modelId: `${providerId}-model`,
      providerConfig: providerConfig(
        `http://127.0.0.1:${port}/${providerId}/v1`,
        keys.get(providerId)!,
      ) as never,
      modelConfig: modelConfig() as never,
      options: { reasoningLevel: "off" },
    });
  try {
    const modelA = makeModel("provider-a");
    const modelB = makeModel("provider-b");
    const modelC = makeModel("provider-c");
    const results = await Promise.allSettled([collect(modelA), collect(modelB), collect(modelC)]);
    assert.equal(results[0]?.status, "rejected");
    assert.equal(results[1]?.status, "fulfilled");
    assert.equal(results[2]?.status, "fulfilled");

    await collect(modelB);
    const failure = statuses.find(
      (event): event is Extract<ModelNetworkStatusEvent, { type: "model_request_failed" }> =>
        event.type === "model_request_failed" && event.providerId === "provider-a",
    );
    assert.ok(failure, "provider A must publish a scoped failed status");
    assert.equal(failure.statusCode, 401);
    assert.equal(failure.reason, "auth_failed");
    assert.equal(failure.retryable, false);
    assert.equal(
      statuses.some(
        (event) =>
          event.type === "model_request_failed" &&
          (event.providerId === "provider-b" || event.providerId === "provider-c"),
      ),
      false,
    );
    assert.equal(
      statuses.filter(
        (event) => event.type === "model_request_completed" && event.providerId === "provider-b",
      ).length,
      2,
    );
    assert.equal(
      statuses.filter(
        (event) => event.type === "model_request_completed" && event.providerId === "provider-c",
      ).length,
      1,
    );
    assert.deepEqual([...keys.entries()], keySnapshot);
    assert.deepEqual(
      requests.map(({ route }) => route).sort(),
      ["provider-a", "provider-b", "provider-b", "provider-c"].sort(),
    );
    assert.equal(
      requests
        .filter(({ route }) => route === "provider-b")
        .every(({ authorization }) => authorization === "Bearer key-b"),
      true,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("expired-provider session history lists and reads offline without a provider or adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-expired-provider-history-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "expired-provider-history",
    execution: {
      targetId: "local",
      workspaceIdentity: "offline-workspace",
      worktreePath: worktree,
    },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed" as const,
      selection: {
        providerId: "removed-provider",
        modelId: "expired-model",
        options: { reasoningLevel: "off" },
      },
    },
  };
  const registry = new HarnessRegistry();
  registry.register(
    new MockHarness({ textChunks: ["retained ", "offline history"], failAfterText: true }),
  );
  const target = new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog: { fingerprint: "v1", validateSelection: () => ({ ok: true as const }) },
    registry,
    authorizeWorktree: async () => true,
  });
  try {
    const bridge = createAgentHostConversationBridge(target);
    await bridge.createExternalSession({ spec });
    await target.dispatch(spec, {
      type: "send",
      commandId: "expired-provider-send",
      hostSessionId: spec.hostSessionId,
      turnId: "expired-provider-turn",
      text: "write nothing; preserve this history",
    });
    await target.waitForIdle(spec);
    await target.dispatch(spec, {
      type: "terminateSession",
      commandId: "expired-provider-terminate",
      hostSessionId: spec.hostSessionId,
    });
    await target.close();
    bridge.dispose();

    const offlineTarget = new AgentHostTargetService({
      root: join(root, "host"),
      target: {
        id: "local",
        kind: "local",
        platform: process.platform as "darwin" | "linux",
        available: true,
      },
      catalog: {
        fingerprint: "offline-catalog",
        validateSelection: () => ({ ok: false as const, reason: "provider removed" }),
      },
      registry: new HarnessRegistry(),
      authorizeWorktree: async () => true,
    });
    const summaries = await offlineTarget.listSessions("offline-workspace", worktree);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.spec.modelBinding.selection.providerId, "removed-provider");
    const snapshot = await offlineTarget.snapshot(spec);
    assert.equal(
      snapshot.rows.window.some((row) => JSON.stringify(row).includes("retained offline history")),
      true,
    );
    const rows = await offlineTarget.conversationRowsRange(spec, {
      sessionId: spec.hostSessionId,
      limit: 50,
    });
    assert.equal(
      rows.rows.some((row) => JSON.stringify(row).includes("retained offline history")),
      true,
    );
    await offlineTarget.close();
  } finally {
    await target.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
