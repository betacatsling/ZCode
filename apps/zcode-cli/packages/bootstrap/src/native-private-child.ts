// 手工 opt-in 私有验证子进程：仅父进程创建的一次性 HOME；不得把原始请求/密钥写到 IPC。
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const route = process.argv[2];
const approved: Record<string, string> = {
  "stepfun/step-3.5-flash": "stepfun",
  "axonhub/deepseek-v4-flash": "axonhub",
};
const originalHome = process.env.HOME;
const isolated = process.cwd();
// 修复：所有 product imports/side effects 之前先切断真实用户配置和日志落点。
process.env.HOME = isolated;
process.env.XDG_CONFIG_HOME = isolated;
process.env.XDG_DATA_HOME = isolated;
process.env.XDG_CACHE_HOME = isolated;
process.env.ZCODE_DATA_BASE_DIR = isolated;
process.env.ZCODE_SESSION_DB_PATH = "native.sqlite";
process.env.ZCODE_TELEMETRY_ENABLED = "false";
process.env.ZCODE_MODEL_RETRY_MAX_RETRIES = "0";

const notify = (value: object) => process.send?.(value);
let attempts = 0;
let modelCalls = 0;
let stage: "configuration" | "bootstrap" | "runtime" = "configuration";
try {
  if (!route || !approved[route]) throw new Error("route not approved");
  if (!originalHome) throw new Error("private config unavailable");
  const providerId = approved[route]!;
  const modelId = route.slice(providerId.length + 1);
  // 私有 loader 只在显式 --live 子进程运行；不把 key/url 放进 argv/env/overlay/IPC。
  const config = JSON.parse(
    await readFile(join(originalHome, ".pi", "agent", "models.json"), "utf8"),
  ) as {
    providers?: Record<
      string,
      { api: string; baseUrl: string; apiKey: string; models: Array<{ id: string }> }
    >;
  };
  const selected = config.providers?.[providerId];
  const api = selected?.api;
  if (
    !selected?.apiKey ||
    !selected.baseUrl ||
    !selected.models.some((model) => model.id === modelId) ||
    !isApprovedApi(api)
  )
    throw new Error("selected local model configuration unavailable");
  stage = "bootstrap";
  const expectedUrl = new URL(selected.baseUrl);
  if (expectedUrl.protocol !== "https:") throw new Error("live endpoint must use HTTPS");
  const [{ runZCodeProtocolAgent }, { AiSdkModelAdapter }, provider, { createPrivateObservation }] =
    await Promise.all([
      import("./zcode-protocol-entrypoint.js"),
      import("@zcode/adapters/model"),
      import("@zcode/provider"),
      import("./native-private-observer.js"),
    ]);
  const revision = "private-disposable-v1";
  const registry = new provider.ProviderRegistryService({
    configSource: {
      read: async () => ({
        revision,
        zcodeBuiltinRevision: revision,
        personalRevision: revision,
        zcodeBuiltinProviders: provider.ProviderConfigMap.empty(),
        zcodeBuiltinProviderTemplates: new provider.ProviderTemplateMap(),
        personalProviders: new provider.ProviderConfigMap([
          [
            providerId,
            new provider.ProviderConfig({
              group: "standard-personal",
              access: new provider.ApiKeyAccessConfig({ apiKey: selected.apiKey }),
              api: new provider.ProviderApiConfig({ type: api, baseUrl: selected.baseUrl }),
              personalModelIds: [modelId],
            }),
          ],
        ]),
        zcodeBuiltinModelRules: provider.ModelConfigRules.empty(),
        personalModels: provider.ModelConfigRules.empty().setExact(
          providerId,
          modelId,
          provider.ModelConfig.fromData({
            enabled: true,
            properties: {
              contextWindow: 65536,
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
              reasoningLevel: { values: ["off"], map: "{}" },
              maxOutputTokens: { max: 2048, map: "{}" },
            },
          }),
        ),
      }),
      onDidChange: () => () => {},
    },
    accountSource: {
      read: async () => ({
        revision: "none",
        basedOnZCodeBuiltinRevision: revision,
        providers: provider.ProviderConfigMap.empty(),
      }),
      onDidChange: () => () => {},
    },
  });
  await registry.start();
  const snapshot = registry.getSnapshot()!;
  const { createPrivateNoopLoggerFactory } = await import("./native-private-logger.js");
  const observation = createPrivateObservation({
    providerId,
    modelId,
    baseUrl: selected.baseUrl,
    api,
    fetch: globalThis.fetch.bind(globalThis),
    notify,
  });
  const { createPrivateEffectPorts } = await import("./native-private-effects.js");
  const cwd = join(isolated, "worktree");
  const effects = createPrivateEffectPorts({
    cwd,
    readPath: join(cwd, "input.txt"),
    writePath: join(cwd, "output.txt"),
    writeContent: await readFile(join(cwd, "approved-content.txt"), "utf8"),
    bashCommand: "node verify.cjs",
    processEnv: process.env,
  });
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "kind" in message &&
      "phase" in message &&
      message.kind === "private-phase" &&
      [1, 2, 3].includes(Number(message.phase))
    ) {
      effects.setPhase(Number(message.phase) as 1 | 2 | 3);
      notify({ kind: "private-phase-ready", phase: message.phase });
    }
  });
  const adapter = new AiSdkModelAdapter({
    // 修复：proxy-aware transport 在启用代理时可绕过注入的 fetch；私有验证明确不走代理，
    // 保证每次 SDK HTTP request 都先经过同一个观察/准入闸门。不支持需要代理的本地路由。
    env: {},
    retry: { maxAttempts: 1 },
    onModelCall: observation.onModelCall,
    transport: observation.transport,
  });

  stage = "runtime";
  try {
    await runZCodeProtocolAgent(
      {
        cwd,
        env: process.env,
        input: process.stdin,
        output: process.stdout,
      },
      {
        modelAdapter: adapter,
        loggerFactory: createPrivateNoopLoggerFactory(),
        fileSystemPort: effects.fileSystemPort,
        executionPort: effects.executionPort,
        startProviderRegistryRuntime: async () => ({
          runtime: { registryService: registry },
          snapshot,
          configuredDefaultModelSelection: { providerId, modelId },
          syncAccountProviderConfig: async () => {
            throw new Error("account overlay forbidden");
          },
          dispose: () => registry.dispose(),
        }),
      },
    );
  } finally {
    await effects.dispose();
    registry.dispose();
  }
  ({ httpAttempts: attempts, modelCalls } = observation.counts);
  process.send?.({ kind: "exit", attempts, modelCalls }, () => process.disconnect?.());
} catch {
  // SDK/provider error cause may echo endpoint, key, prompt or response. Never serialize it.
  process.send?.({ kind: "failure", stage, attempts, modelCalls }, () => process.disconnect?.());
  process.exitCode = 1;
}

function isApprovedApi(
  value: string | undefined,
): value is "anthropic-messages" | "openai-chat-completions" | "openai-responses" {
  return (
    value === "anthropic-messages" ||
    value === "openai-chat-completions" ||
    value === "openai-responses"
  );
}
