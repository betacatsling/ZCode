/**
 * Shared real-host wiring for provider tests: real node Provider Registry runtime with personal
 * Providers, real Pi harness and AgentHostTargetService. Callers bring their own AiSdkModelAdapter
 * (retry/statusSink/recording) and loopback fake Provider.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
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

export type AdapterRetry = ConstructorParameters<typeof AiSdkModelAdapter>[0]["retry"];
export type RegistryRuntime = ReturnType<typeof createNodeProviderRegistryRuntime>;

export function modelConfig(): ModelConfig {
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

export function providerConfig(baseUrl: string, apiKey: string): ProviderConfig {
  return new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
  });
}

/** Creates `<root>/worktree` and starts a Registry runtime on `<root>/personal.json`. */
export async function startRegistryRuntime(root: string) {
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
  const runtime = createNodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath: join(root, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  await runtime.start();
  return { runtime, worktree };
}

/** One personal openai-chat-completions Provider with one model; caller refreshes the Registry. */
export async function addPersonalProvider(
  runtime: RegistryRuntime,
  input: { providerName: string; baseUrl: string; apiKey: string; modelId: string },
): Promise<string> {
  const provider = await runtime.configService.createPersonalProvider({
    providerName: input.providerName,
    initialConfig: providerConfig(input.baseUrl, input.apiKey),
  });
  await runtime.configService.addPersonalModel(provider.providerId, input.modelId, modelConfig());
  return provider.providerId;
}

export function localTarget(id: string) {
  return {
    id,
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
}

/** Real Pi harness + AgentHostTargetService over the Registry, like lazyTargetService. */
export function createPiTargetService(input: {
  root: string;
  runtime: RegistryRuntime;
  adapter: AiSdkModelAdapter;
  target: ReturnType<typeof localTarget>;
  catalog?: ReturnType<typeof createRegistryModelCatalog>;
}): AgentHostTargetService {
  const catalog =
    input.catalog ?? createRegistryModelCatalog(input.runtime.registryService, input.adapter);
  const harnesses = new HarnessRegistry();
  harnesses.register(
    createRegistryPiHarness({
      root: join(input.root, "workers"),
      registry: input.runtime.registryService,
      adapter: input.adapter,
    }),
  );
  return new AgentHostTargetService({
    root: join(input.root, "host"),
    target: input.target,
    catalog,
    registry: harnesses,
    authorizeWorktree: async () => true,
  });
}

/** Pi session on a host-managed Registry model with reasoning off. */
export function hostManagedPiSpec(input: {
  hostSessionId: string;
  targetId: string;
  workspaceIdentity: string;
  worktreePath: string;
  selection: { providerId: string; modelId: string };
}): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId: input.hostSessionId,
    execution: {
      targetId: input.targetId,
      workspaceIdentity: input.workspaceIdentity,
      worktreePath: input.worktreePath,
    },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding: {
      kind: "host-managed",
      selection: { ...input.selection, options: { reasoningLevel: "off" } },
    },
  };
}
