// 手工 opt-in 私有验证子进程：仅父进程创建的一次性 HOME；不得把原始请求/密钥写到 IPC。
import { readFile } from "node:fs/promises";
import { scanDisposable } from "../../../../../scripts/native-private-artifacts.mjs";
import { join } from "node:path";

const route = process.argv[2];
const fake = route === "fixture/fixture-model";
const approved: Record<string, string> = {
  "stepfun/step-3.5-flash": "stepfun",
  "axonhub/deepseek-v4-flash": "axonhub",
  "fixture/fixture-model": "fixture",
};
const originalHome = process.env.HOME;
const fixtureUrl = fake ? process.env.ZCODE_NATIVE_FAKE_URL : undefined;
const exposeWebFetch = fake && process.env.ZCODE_NATIVE_FAKE_EXPOSE_WEBFETCH === "1";
const hangScan = fake && process.env.ZCODE_NATIVE_FAKE_HANG_SCAN === "1";
const isolated = process.cwd();
// 修复：父环境的密钥、代理、项目配置和运行时开关不能进入私有原生执行器。
for (const key of Object.keys(process.env)) {
  if (!["PATH", "SYSTEMROOT", "WINDIR", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "HOME"].includes(key)) delete process.env[key];
}
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
let dispatches = 0;
let forbiddenToolRequests = 0;
let modelCalls = 0;
let selectedSecrets: string[] = [];
let scanCompleted = false;
let outputClean = true;
let scanFiles = 0;
let observation: ReturnType<typeof import("./native-private-observer.js").createPrivateObservation> | undefined;
let stage: "configuration" | "bootstrap" | "runtime" = "configuration";
try {
  if (!route || !approved[route]) throw new Error("route not approved");
  if (!fake && !originalHome) throw new Error("private config unavailable");
  if (fake && (!fixtureUrl || !/^http:\/\/127\.0\.0\.1:\d+\/fixture$/.test(fixtureUrl)))
    throw new Error("fake endpoint unavailable");
  const providerId = approved[route]!;
  const modelId = route.slice(providerId.length + 1);
  // 私有 loader 只在显式 --live 子进程运行；不把 key/url 放进 argv/env/overlay/IPC。
  const config = (fake ? { providers: { fixture: { api: "anthropic-messages", apiKey: ["fixture-private", "key-sentinel"].join("-"), baseUrl: fixtureUrl!, models: [{ id: "fixture-model", contextWindow: 65536, maxTokens: 4096 }] } } } : JSON.parse(
    await readFile(join(originalHome!, ".pi", "agent", "models.json"), "utf8"),
  )) as {
    providers?: Record<
      string,
      { api: string; baseUrl: string; apiKey: string; models: Array<{ id: string; contextWindow: number; maxTokens: number }> }
    >;
  };
  const selected = config.providers?.[providerId];
  const api = selected?.api;
  const configuredModel = selected?.models.find((model) => model.id === modelId);
  if (
    !selected?.apiKey || !isOpaqueLiteralCredential(selected.apiKey) ||
    !selected.baseUrl ||
    !configuredModel || !Number.isSafeInteger(configuredModel.contextWindow) ||
    configuredModel.contextWindow < 8192 || !Number.isSafeInteger(configuredModel.maxTokens) ||
    configuredModel.maxTokens < 1 ||
    !isApprovedApi(api)
  )
    throw new Error("selected local model configuration unavailable");
  selectedSecrets = [selected.apiKey, selected.baseUrl];
  // 修复：除了磁盘，还要在持有私密值的子进程内检查完整 stdout/stderr（跨 chunk）。
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    let tail = "";
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = tail + (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      if (selectedSecrets.some((secret) => text.includes(secret))) outputClean = false;
      tail = text.slice(-Math.max(...selectedSecrets.map((secret) => secret.length)));
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
  }
  // 修复：AI SDK 自身会把 APICallError 对象（含 url、requestBodyValues）直接
  // console.error，绕过注入的 LoggerFactory；私有子进程禁止该旁路输出。
  console.error = () => {};
  console.warn = () => {};
  console.info = () => {};
  stage = "bootstrap";
  const expectedUrl = new URL(selected.baseUrl);
  if (!fake && expectedUrl.protocol !== "https:") throw new Error("live endpoint must use HTTPS");
  if (expectedUrl.search || expectedUrl.username || expectedUrl.password)
    throw new Error("private route not supported");
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
              contextWindow: configuredModel.contextWindow,
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
              // 原配置数值仅用于 Registry validation；实际每次 max_tokens 在 transport 上强制 <=4096。
              // 不把占位 option map 的 reasoning/off 宣称为已映射的 provider 能力。
              reasoningLevel: { values: ["default"], map: "{}" },
              maxOutputTokens: { max: configuredModel.maxTokens, map: "{}" },
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
  observation = createPrivateObservation({
    providerId,
    modelId,
    baseUrl: selected.baseUrl,
    api,
    fetch: globalThis.fetch.bind(globalThis),
    notify,
    allowedToolNames: exposeWebFetch ? ["Read", "Write", "Bash", "WebFetch"] : ["Read", "Write", "Bash"],
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
        // 修复：preapproved WebFetch 可跳过 permission；必须在真实 HTTP port 入口拒绝。
        httpClientPort: { request: async () => { forbiddenToolRequests++; throw new Error("private nonfixture network denied"); } },
        privateToolAllowlist: exposeWebFetch ? ["Read", "Write", "Bash", "WebFetch"] : ["Read", "Write", "Bash"],
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
  ({ httpAttempts: attempts, httpDispatches: dispatches, modelCalls } = observation.counts);
  if (hangScan) await new Promise<void>(() => setInterval(() => {}, 1000));
  await scanDisposable(isolated, selectedSecrets, { files: 0, bytes: 0 }, (count) => { scanFiles = count; });
  scanCompleted = outputClean;
  process.send?.({ kind: "exit", attempts, dispatches, modelCalls, scanCompleted, scanFiles, forbiddenToolRequests }, () => process.disconnect?.());
} catch {
  // SDK/provider error cause may echo endpoint, key, prompt or response. Never serialize it.
  if (observation) ({ httpAttempts: attempts, httpDispatches: dispatches, modelCalls } = observation.counts);
  try {
    if (selectedSecrets.length === 2) {
      await scanDisposable(isolated, selectedSecrets, { files: 0, bytes: 0 }, (count) => { scanFiles = count; });
      scanCompleted = outputClean;
    }
  } catch { scanCompleted = false; }
  process.send?.({ kind: "failure", stage, attempts, dispatches, modelCalls, scanCompleted, scanFiles, forbiddenToolRequests }, () => process.disconnect?.());
  process.exitCode = 1;
}

function isOpaqueLiteralCredential(value: string): boolean {
  // 修复：未知 env/command/keychain 引用不是已解析的凭据；绝不猜测或执行该引用。
  return value.length >= 12 && !/\s/u.test(value) &&
    !/^(?:!|\$|\{\{|env:|file:|cmd:|exec:|keychain:)/iu.test(value) &&
    !value.includes("${") && !/^[_A-Z][_A-Z0-9]*$/u.test(value);
}

function isApprovedApi(value: string | undefined): value is "anthropic-messages" {
  return value === "anthropic-messages";
}
