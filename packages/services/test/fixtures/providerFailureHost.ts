/**
 * Real Pi target for provider-failure tests: loopback fake Provider (per-key failure status with
 * a key-looking string in the upstream error body), real Registry, real AiSdkModelAdapter and
 * real Pi harness, wired like staleProviderReconfigureNoFallback's host environment.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createNodeProviderRegistryRuntime } from "@zcode/provider-node";
import type { SessionSpec } from "@zcode/shared/agent-host";
import { createRegistryPiHarness } from "../../src/agent-adapters/pi/createPiHarness.js";
import { HarnessRegistry } from "../../src/agent-host/harnessRegistry.js";
import { createRegistryModelCatalog } from "../../src/agent-host/registryCatalog.js";
import { AgentHostTargetService } from "../../src/agent-host/targetService.js";

const builtinFilePath = fileURLToPath(
  new URL("../../../../config/provider/zcode-builtin.json", import.meta.url),
);

/** Appears in the Provider API key and in the upstream error body; must never reach a client. */
export const LEAK_MARKER = "sk-leak";

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
        max: 256,
        map: '{"max_tokens": maxOutputTokens}',
      }),
    }),
  });
}

/** Fake OpenAI-compatible Provider: `failWith` (401/403/...) or a one-chunk streamed answer. */
export async function startFailingProvider() {
  const state: { failWith?: number; requests: number } = { requests: 0 };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      state.requests += 1;
      if (state.failWith !== undefined) {
        response.writeHead(state.failWith, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${LEAK_MARKER}-upstream-echo`,
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    state,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

export async function createProviderFailureHost(
  root: string,
  origin: string,
  retry?: ConstructorParameters<typeof AiSdkModelAdapter>[0]["retry"],
) {
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  const runtime = createNodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath: join(root, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  await runtime.start();
  const provider = await runtime.configService.createPersonalProvider({
    providerName: "Failing Provider",
    initialConfig: new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: `${LEAK_MARKER}-configured-key` }),
      api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: `${origin}/v1` }),
    }),
  });
  await runtime.configService.addPersonalModel(provider.providerId, "failing-model", modelConfig());
  await runtime.registryService.refresh("provider-failure-fixture");
  const adapter = new AiSdkModelAdapter({
    streamIdleTimeoutMs: 5_000,
    ...(retry ? { retry } : {}),
  });
  const targetId = "remote-typed-failure";
  const target = new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: targetId,
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog: createRegistryModelCatalog(runtime.registryService, adapter),
    registry: (() => {
      const harnesses = new HarnessRegistry();
      harnesses.register(
        createRegistryPiHarness({
          root: join(root, "workers"),
          registry: runtime.registryService,
          adapter,
        }),
      );
      return harnesses;
    })(),
    authorizeWorktree: async () => true,
  });
  const specFor = (hostSessionId: string): SessionSpec => ({
    schemaVersion: 1,
    hostSessionId,
    execution: { targetId, workspaceIdentity: "typed-failure-workspace", worktreePath: worktree },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding: {
      kind: "host-managed",
      selection: {
        providerId: provider.providerId,
        modelId: "failing-model",
        options: { reasoningLevel: "off" },
      },
    },
  });
  return {
    target,
    providerId: provider.providerId,
    specFor,
    dispose: async () => {
      await target.close().catch(() => undefined);
      runtime.dispose();
    },
  };
}
