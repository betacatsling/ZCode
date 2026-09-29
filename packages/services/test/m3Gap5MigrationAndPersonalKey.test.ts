import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
import { createNodeProviderRegistryRuntime } from "@zcode/provider-node";
import type { ModelProviderConfig } from "../src/model-provider/legacyModelProviderSerialized.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";

const builtinFilePath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);
const legacyProviders = [
  {
    id: "legacy-provider",
    name: "Legacy Provider",
    enabled: true,
    endpoints: { baseURL: "https://legacy.example/v1" },
    apiFormat: "openai-chat-completions",
    source: "custom",
    apiKey: "legacy-secret",
    models: ["legacy-model"],
    createdAt: 1,
    updatedAt: 1,
  },
] as const;

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

async function collect(model: ReturnType<AiSdkModelAdapter["createModel"]>): Promise<void> {
  for await (const _event of model.streamText({
    messages: [{ role: "user", content: "hello" }],
    options: { reasoningLevel: "off", maxOutputTokens: 32 },
  })) {
    // Consume the whole stream to prove the key-backed call completed.
  }
}

async function migrationRuntime(
  personalFilePath: string,
  readLegacyProviders: () => Promise<readonly ModelProviderConfig[]>,
) {
  return createProviderConfigRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath,
    personalPollingIntervalMs: false,
    watch: false,
    readLegacyProviders,
  });
}

test("legacy personal-key migration is idempotent and preserves edits and secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-m3-gap5-migration-"));
  const personalFilePath = join(root, "personal.json");
  let firstReads = 0;
  const first = await migrationRuntime(personalFilePath, async () => {
    firstReads += 1;
    return legacyProviders;
  });
  try {
    await first.start();
    const imported = await first.configService.read();
    assert.equal(firstReads, 1);
    assert.equal(imported.personalProviders.get("legacy-provider")?.access?.type, "api-key");
    assert.equal(
      imported.personalProviders.get("legacy-provider")?.access?.apiKey,
      "legacy-secret",
    );
    assert.deepEqual(imported.personalProviders.get("legacy-provider")?.personalModelIds, [
      "legacy-model",
    ]);

    await first.configService.savePersonalProviderOverlay(
      "legacy-provider",
      new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey: "user-edited-secret" }),
        api: new ProviderApiConfig({
          type: "openai-chat-completions",
          baseUrl: "https://user-edited.example/v1",
        }),
      }),
    );
    const editedBytes = await readFile(personalFilePath, "utf8");
    const edited = await first.configService.read();
    assert.equal(
      edited.personalProviders.get("legacy-provider")?.access?.apiKey,
      "user-edited-secret",
    );
    assert.equal(
      edited.personalProviders.get("legacy-provider")?.api?.baseUrl,
      "https://user-edited.example/v1",
    );

    first.dispose();
    let secondReads = 0;
    const second = await migrationRuntime(personalFilePath, async () => {
      secondReads += 1;
      throw new Error("legacy source must not be consulted after migration");
    });
    try {
      await second.start();
      const reloaded = await second.configService.read();
      assert.equal(secondReads, 0);
      assert.equal(
        reloaded.personalProviders.get("legacy-provider")?.access?.apiKey,
        "user-edited-secret",
      );
      assert.equal(
        reloaded.personalProviders.get("legacy-provider")?.api?.baseUrl,
        "https://user-edited.example/v1",
      );
      assert.deepEqual(reloaded.personalProviders.get("legacy-provider")?.personalModelIds, [
        "legacy-model",
      ]);
      assert.equal(await readFile(personalFilePath, "utf8"), editedBytes);
      const persisted = JSON.parse(editedBytes) as {
        config?: { providerConfigRules?: { providerRules?: unknown[] } };
      };
      assert.equal(persisted.config?.providerConfigRules?.providerRules?.length, 1);
      assert.equal(editedBytes.includes("legacy-secret"), false);
      assert.equal(editedBytes.includes("user-edited-secret"), true);
    } finally {
      second.dispose();
    }
  } finally {
    first.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing personal file after an interrupted migration reruns without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-m3-gap5-interrupted-"));
  const personalFilePath = join(root, "personal.json");
  let reads = 0;
  const run = () =>
    migrationRuntime(personalFilePath, async () => {
      reads += 1;
      return legacyProviders;
    });
  try {
    const first = await run();
    await first.start();
    first.dispose();
    await rm(personalFilePath);

    const rerun = await run();
    try {
      await rerun.start();
      const config = await rerun.configService.read();
      assert.equal(reads, 2);
      assert.equal(config.personalProviders.keys().length, 1);
      assert.equal(
        config.personalProviders.get("legacy-provider")?.access?.apiKey,
        "legacy-secret",
      );
      assert.deepEqual(config.personalProviders.get("legacy-provider")?.personalModelIds, [
        "legacy-model",
      ]);
      const persisted = JSON.parse(await readFile(personalFilePath, "utf8")) as {
        config?: { providerConfigRules?: { providerRules?: unknown[] } };
      };
      assert.equal(persisted.config?.providerConfigRules?.providerRules?.length, 1);
    } finally {
      rerun.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("personal key entry persists, reloads into the registry, calls a local fake, and stays out of telemetry", async () => {
  const requests: Array<{ authorization: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
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
  const root = await mkdtemp(join(tmpdir(), "zcode-m3-gap5-key-e2e-"));
  const personalFilePath = join(root, "personal.json");
  const runtime = createNodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath,
    personalPollingIntervalMs: false,
    watch: false,
  });
  const secret = "personal-key-never-in-status";
  try {
    await runtime.start();
    const created = await runtime.configService.createPersonalProvider({
      providerName: "Fixture Personal Provider",
      initialConfig: new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey: secret }),
        api: new ProviderApiConfig({
          type: "openai-chat-completions",
          baseUrl: `http://127.0.0.1:${port}/v1`,
        }),
      }),
    });
    await runtime.configService.addPersonalModel(
      created.providerId,
      "fixture-model",
      modelConfig(),
    );
    await runtime.registryService.refresh("test-personal-key-entry");
    const resolvedProvider = runtime.registryService.getProvider(created.providerId);
    const resolvedModel = runtime.registryService.getModel(created.providerId, "fixture-model");
    assert.ok(resolvedProvider);
    assert.ok(resolvedModel);
    assert.equal(resolvedProvider.config.access.apiKey, secret);
    assert.equal(
      await readFile(personalFilePath, "utf8").then((text) => text.includes(secret)),
      true,
    );

    runtime.dispose();
    const reloadedRuntime = createNodeProviderRegistryRuntime({
      zcodeBuiltinFilePath: builtinFilePath,
      personalFilePath,
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      await reloadedRuntime.start();
      await reloadedRuntime.registryService.refresh("test-reload");
      const reloadedProvider = reloadedRuntime.registryService.getProvider(created.providerId);
      const reloadedModel = reloadedRuntime.registryService.getModel(
        created.providerId,
        "fixture-model",
      );
      assert.ok(reloadedProvider);
      assert.ok(reloadedModel);
      const statuses: ModelNetworkStatusEvent[] = [];
      const logs: unknown[] = [];
      const adapter = new AiSdkModelAdapter({
        streamIdleTimeoutMs: 5_000,
        statusSink: { publish: (event) => statuses.push(event) },
        logger: {
          debug: (...args: unknown[]) => logs.push(args),
          info: (...args: unknown[]) => logs.push(args),
          warn: (...args: unknown[]) => logs.push(args),
          error: (...args: unknown[]) => logs.push(args),
        } as never,
      });
      await collect(
        adapter.createModel({
          providerId: created.providerId,
          modelId: "fixture-model",
          providerConfig: reloadedProvider.config as never,
          modelConfig: reloadedModel.config as never,
          options: { reasoningLevel: "off" },
        }),
      );
      assert.deepEqual(
        requests.map(({ authorization }) => authorization),
        [`Bearer ${secret}`],
      );
      assert.equal(
        statuses.some(
          (event) =>
            event.type === "model_request_completed" && event.providerId === created.providerId,
        ),
        true,
      );
      assert.equal(JSON.stringify(statuses).includes(secret), false);
      assert.equal(JSON.stringify(logs).includes(secret), false);
    } finally {
      reloadedRuntime.dispose();
    }
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
