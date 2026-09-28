/* eslint-disable max-lines -- live certification keeps budget, provider mapping and fixture gate in one auditable executable. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ModelStatusSink, ModelUsage } from "@zcode/contracts";
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
  ProviderRegistry,
  createRegistryModelConfig,
  createRegistryProviderConfig,
} from "@zcode/provider";
import { createRegistryPiHarness } from "../../src/agent-adapters/pi/createPiHarness.js";
import { HarnessRegistry } from "../../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../../src/agent-host/sessionHost.js";
import type { AgentEvent, SessionSpec } from "@zcode/shared/agent-host";

const execFileAsync = promisify(execFile);
const providerId = process.env.CERTIFY_PROVIDER?.trim() || "stepfun";
const modelId = process.env.CERTIFY_MODEL?.trim() || "step-3.5-flash";
const PI_SDK_VERSION = "0.87.1";
// The status milestone arrives after a request starts; stopping at >9 keeps the
// observed physical request count at most 10 for the bounded Axon run.
const MAX_MODEL_REQUESTS = providerId === "axonhub" ? 9 : 7;
const MAX_OUTPUT_TOKENS = 512;
const MAX_INPUT_TOKENS = 8_000;
const INPUT_USD_PER_MILLION = 0.1;
const OUTPUT_USD_PER_MILLION = 0.3;

interface ModelRequestAttempt {
  requestId: string;
  providerId: string;
  modelId: string;
  attempt: number;
  outcome:
    | "started"
    | "blocked-before-send"
    | "usage-reported"
    | "completed-without-usage"
    | "failed";
}

interface PiConfigModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}
interface PiConfigProvider {
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: PiConfigModel[];
}
interface PiModelsFile {
  providers?: Record<string, PiConfigProvider>;
}

const sanitizedSecrets: string[] = [];
const modelRequests: ModelRequestAttempt[] = [];
const usages: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }> = [];
const eventTrace: Array<{ kind: string; summary?: string }> = [];
const modelFailures: Array<{ reason: string; message: string; statusCode?: number }> = [];
const modelFailureDetails: string[] = [];
let budgetExceeded = false;
let blockedBeforeSend = 0;
let completedWithoutUsage = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitize(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of sanitizedSecrets) if (secret) text = text.replaceAll(secret, "<redacted>");
  return text
    .replaceAll(/https?:\/\/[^\s)]+/giu, "<endpoint-redacted>")
    .replaceAll(/(?:Bearer|Basic)\s+[^\s]+/giu, "<auth-redacted>")
    .replaceAll(/[A-Za-z0-9_-]{40,}/gu, "<token-redacted>");
}

function usageOf(usage?: ModelUsage): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
  };
}

function attemptAudit() {
  const unknownOutcomes = modelRequests.filter(
    (request) =>
      request.outcome === "started" ||
      request.outcome === "completed-without-usage" ||
      request.outcome === "failed",
  ).length;
  return {
    logicalAttempts: modelRequests.length,
    reportedUsageResponses: usages.length,
    blockedBeforeSend,
    completedWithoutUsage,
    failedAttempts: modelFailures.length,
    unknownOutcomes,
    physicalHttpRequests: "not-observed-by-model-status-sink",
  };
}

function findOpenAttempt(requestId: string) {
  return [...modelRequests]
    .reverse()
    .find((request) => request.requestId === requestId && request.outcome === "started");
}

const REMOTE_AXON_LOOKUP = [
  "import json, pathlib",
  "p = pathlib.Path.home() / '.pi/agent/models.json'",
  "print(json.dumps(json.loads(p.read_text()).get('providers', {}).get('axonhub', {}), separators=(',', ':'))) ",
].join("\n");

async function readAxonProviderFromMac(alias: string): Promise<PiConfigProvider> {
  const child = spawn("ssh", [alias, "/usr/bin/python3", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.resume();
  child.stdin.end(REMOTE_AXON_LOOKUP);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  if (code !== 0) throw new Error("Mac Axon provider lookup failed");
  const value = JSON.parse(stdout) as PiConfigProvider;
  const key = value.apiKey ?? "";
  if (!key || key.startsWith("$") || key.startsWith("!") || key.startsWith("command:")) {
    throw new Error("Mac Axon provider lookup did not return a literal key");
  }
  return value;
}

function statusSink(): ModelStatusSink {
  return {
    publish(event) {
      if (event.type === "model_request_started") {
        const attempt: ModelRequestAttempt = {
          requestId: event.requestId,
          providerId: event.providerId,
          modelId: event.modelId,
          attempt: event.attempt,
          outcome: "started",
        };
        modelRequests.push(attempt);
        if (modelRequests.length > MAX_MODEL_REQUESTS) {
          budgetExceeded = true;
          // Adapter start milestones precede opening the provider stream, so this
          // fixture guard rejects the over-limit logical attempt before send.
          attempt.outcome = "blocked-before-send";
          blockedBeforeSend += 1;
          throw new Error("live model request budget exceeded");
        }
      }
      if (event.type === "model_request_completed" && event.usage) {
        const usage = usageOf(event.usage);
        usages.push(usage);
        const attempt = findOpenAttempt(event.requestId);
        if (attempt) attempt.outcome = "usage-reported";
        if (usage.inputTokens > MAX_INPUT_TOKENS) budgetExceeded = true;
      }
      if (event.type === "model_request_completed" && !event.usage) {
        completedWithoutUsage += 1;
        const attempt = findOpenAttempt(event.requestId);
        if (attempt) attempt.outcome = "completed-without-usage";
      }
      if (event.type === "model_request_failed") {
        modelFailures.push({
          reason: event.reason,
          message: sanitize(event.message),
          ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }),
        });
        const attempt = findOpenAttempt(event.requestId);
        if (attempt) attempt.outcome = "failed";
      }
    },
    publishFailure(_event, error) {
      modelFailureDetails.push(sanitize(error));
    },
  };
}

function makeProviderConfig(
  config: PiConfigProvider,
  selectedModel: PiConfigModel,
): ProviderConfig {
  const apiType =
    config.api === "anthropic-messages" ? "anthropic-messages" : "openai-chat-completions";
  if (!config.baseUrl || !config.apiKey)
    throw new Error(`Provider ${providerId} is missing configured API metadata`);
  sanitizedSecrets.push(config.apiKey, config.baseUrl);
  const headers = config.authHeader
    ? { Authorization: `Bearer ${config.apiKey}`, ...config.headers }
    : config.headers;
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: config.apiKey }),
    api: new ProviderApiConfig({ type: apiType, baseUrl: config.baseUrl, headers }),
    personalModelIds: [selectedModel.id],
  });
}

function makeModelConfig(config: PiConfigModel, api?: string): ModelConfig {
  const contextWindow = config.contextWindow ?? 256_000;
  const reasoningValues = [api === "anthropic-messages" ? "off" : "low"];
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow,
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
      // Step 3.5 is selected at the lowest provider-supported low effort.
      // Anthropic-compatible DeepSeek uses the native disabled thinking switch.
      reasoningLevel: new EnumOptionSpecConfig({
        values: reasoningValues,
        map:
          api === "anthropic-messages"
            ? '{"thinking": {"type": "disabled"}}'
            : '{"reasoning_effort": "low"}',
      }),
      maxOutputTokens: new LimitOptionSpecConfig({
        max: Math.min(MAX_OUTPUT_TOKENS, config.maxTokens ?? MAX_OUTPUT_TOKENS),
        map: '{"maxOutputTokens": {"value": maxOutputTokens} }',
      }),
    }),
  });
}

function createRegistry(config: PiConfigProvider, selectedModel: PiConfigModel) {
  const providerConfig = makeProviderConfig(config, selectedModel);
  const modelConfig = makeModelConfig(selectedModel, config.api);
  // PiConfigModel 不包含 API 类型；必须使用 Provider 层传入的 api 参数，保留 Anthropic messages thinking 关闭语义。
  const resolvedProviderConfig = createRegistryProviderConfig(providerConfig);
  if (!resolvedProviderConfig.ok) throw new Error("live Provider Config is incomplete");
  const resolvedModelConfig = createRegistryModelConfig(modelConfig);
  if (!resolvedModelConfig.ok) throw new Error("live Model Config is incomplete");
  const provider = {
    providerId,
    providerName: providerId,
    config: resolvedProviderConfig.config,
    models: [{ modelId: selectedModel.id, config: resolvedModelConfig.config }],
  } as const;
  const registry = new ProviderRegistry([provider]);
  const sourceRevisions = {
    config: `live-certification:${providerId}`,
    account: "live-certification:none",
  };
  const snapshot = { sourceRevisions, registry: registry.getView() };
  const service = {
    getSnapshot: () => snapshot,
    validateSelection: registry.validateSelection.bind(registry),
    getProvider: registry.getProvider.bind(registry),
    getModel: registry.getModel.bind(registry),
  };
  return {
    registry: service,
    fingerprint: JSON.stringify(sourceRevisions),
    selectedModel,
    providerConfig,
    modelConfig,
  };
}

async function runGit(worktree: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: worktree,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function latestAssistantText(events: readonly AgentEvent[]): string {
  return (
    events
      .filter(
        (event): event is Extract<AgentEvent, { kind: "message.finished" }> =>
          event.kind === "message.finished" && event.role === "assistant",
      )
      .at(-1)?.text ?? ""
  );
}

async function waitForTurn(events: AgentEvent[], turnId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!events.some((event) => event.kind === "turn.finished" && event.turnId === turnId)) {
    if (Date.now() > deadline) throw new Error(`Pi turn did not finish: ${turnId}`);
    await sleep(50);
  }
}

async function main(): Promise<void> {
  const modelsPath =
    process.env.PI_MODELS_PATH?.trim() || join(homedir(), ".pi", "agent", "models.json");
  const raw = process.env.CERTIFY_AXON_SSH_ALIAS
    ? undefined
    : (JSON.parse(await readFile(modelsPath, "utf8")) as PiModelsFile);
  const providerConfig =
    providerId === "axonhub" && process.env.CERTIFY_AXON_SSH_ALIAS
      ? await readAxonProviderFromMac(process.env.CERTIFY_AXON_SSH_ALIAS)
      : raw?.providers?.[providerId];
  const selectedModel = providerConfig?.models?.find((model) => model.id === modelId);
  if (!providerConfig || !selectedModel)
    throw new Error(`Configured live model is unavailable: ${providerId}/${modelId}`);
  const route = createRegistry(providerConfig, selectedModel);
  const reasoningLevel = providerId === "stepfun" ? "low" : "off";
  const selection = { providerId, modelId, options: { reasoningLevel } } as const;
  if (process.env.CERTIFY_VALIDATE_ONLY === "1") {
    console.log(
      JSON.stringify({
        status: "validate-only",
        actualNodeVersion: process.version,
        cliArtifactSha256: null,
        source: "real-provider-config-no-call",
        scenario: "validate-only",
        providerId,
        modelId,
        configOrigin: process.env.CERTIFY_AXON_SSH_ALIAS ? "mac-private-ssh-memory" : "local-file",
        api: providerConfig.api,
        authHeader: providerConfig.authHeader === true,
        headersConfigured: Boolean(providerConfig.headers),
        apiKeyKind:
          providerConfig.apiKey?.startsWith("$") ||
          providerConfig.apiKey?.startsWith("!") ||
          providerConfig.apiKey?.startsWith("command:")
            ? "reference"
            : "literal",
        reasoningLevel,
        registryValidation: route.registry.validateSelection(selection),
        optionValues: route.modelConfig.optionSpecs?.reasoningLevel?.values,
        attemptAudit: attemptAudit(),
      }),
    );
    return;
  }
  if (process.env.CERTIFY_DIRECT === "1") {
    const directEvents: string[] = [];
    const adapter = new AiSdkModelAdapter({
      statusSink: statusSink(),
      streamIdleTimeoutMs: 30_000,
    });
    const model = adapter.createModel({
      providerId,
      modelId,
      providerConfig: route.providerConfig as never,
      modelConfig: route.modelConfig as never,
      options: { reasoningLevel },
    });
    for await (const event of model.streamText({
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      tools: [],
      options: { maxOutputTokens: MAX_OUTPUT_TOKENS, reasoningLevel },
    }))
      directEvents.push(event.type);
    console.log(
      JSON.stringify({
        status: "direct-real-provider-pass",
        actualNodeVersion: process.version,
        cliArtifactSha256: null,
        source: "real-provider",
        scenario: "direct-single-prompt",
        providerId,
        modelId,
        eventTypes: directEvents,
        modelRequests: modelRequests.length,
        usages,
        modelFailures,
        modelFailureDetails,
        attemptAudit: attemptAudit(),
      }),
    );
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-live-certify-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  await runGit(worktree, ["init", "-q"]);
  const expected = "processed: source-marker";
  await writeFile(join(worktree, "input.txt"), "source-marker\n", { mode: 0o600 });
  await writeFile(
    join(worktree, "check.mjs"),
    `import { readFileSync } from "node:fs"; if (readFileSync("output.txt", "utf8").trim() !== ${JSON.stringify(expected)}) process.exit(1);\n`,
    { mode: 0o700 },
  );

  const spec: SessionSpec = {
    schemaVersion: 1,
    hostSessionId: `live-${providerId}-${Date.now()}`,
    execution: {
      targetId: `live-${process.platform}`,
      workspaceIdentity: `live-${providerId}`,
      worktreePath: worktree,
    },
    harness: { id: "pi", adapterVersion: PI_SDK_VERSION },
    modelBinding: { kind: "host-managed", selection },
  };
  const target = {
    id: spec.execution.targetId,
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
  const harness = createRegistryPiHarness({
    root: join(root, "workers"),
    registry: route.registry as never,
    adapter: new AiSdkModelAdapter({ statusSink: statusSink(), streamIdleTimeoutMs: 30_000 }),
  });
  const harnesses = new HarnessRegistry();
  harnesses.register(harness);
  const catalog = {
    fingerprint: route.fingerprint,
    validateSelection: (value: typeof selection) => {
      const result = route.registry.validateSelection(value);
      return result.ok ? { ok: true as const } : { ok: false as const, reason: result.code };
    },
  };
  let host: SessionHost | undefined;
  const events: AgentEvent[] = [];
  let allowWrites = true;
  let approvalError: string | undefined;
  let denyTurnId: string | undefined;
  let denialObserved = false;
  try {
    host = await SessionHost.create({
      root: join(root, "journals"),
      spec,
      target,
      registry: harnesses,
      catalog,
    });
    host.subscribe((event) => {
      events.push(event);
      eventTrace.push({
        kind: event.kind,
        ...(event.kind === "interaction.requested"
          ? { summary: event.summary.replaceAll(worktree, "<isolated>").slice(0, 180) }
          : {}),
        ...(event.kind === "session.error"
          ? { summary: `${event.code}: ${event.message}`.slice(0, 240) }
          : {}),
        ...(event.kind === "turn.finished" ? { summary: event.outcome } : {}),
      });
      if (event.kind !== "interaction.requested") return;
      const safeBashCommands = new Set([
        "Run Pi bash command: node check.mjs",
        `Run Pi bash command: node ${join(worktree, "check.mjs")}`,
        `Run Pi bash command: cd ${worktree} && node check.mjs`,
        `Run Pi bash command: ls ${worktree}/`,
        `Run Pi bash command: cat ${join(worktree, "output.txt")}`,
      ]);
      const allow =
        allowWrites &&
        (event.summary.startsWith("Allow Pi write") ||
          event.summary.startsWith("Allow Pi edit") ||
          safeBashCommands.has(event.summary));
      void (async () => {
        await host!.dispatch({
          type: "resolveInteraction",
          commandId: `approval-${event.interactionId}`,
          hostSessionId: spec.hostSessionId,
          runtimeEpoch: host!.binding.runtimeEpoch,
          turnId: event.turnId,
          interactionId: event.interactionId,
          decision: allow ? "allow" : "deny",
        });
        if (!allow && event.turnId === denyTurnId) {
          denialObserved = true;
          await host!.dispatch({
            type: "cancelTurn",
            commandId: `cancel-${event.turnId}`,
            hostSessionId: spec.hostSessionId,
            runtimeEpoch: host!.binding.runtimeEpoch,
            turnId: event.turnId,
          });
        }
      })().catch((error: unknown) => {
        approvalError = sanitize(error);
      });
    });

    if (process.env.CERTIFY_DENY_ONLY === "1") {
      allowWrites = false;
      denyTurnId = "turn-1";
      const deniedOnly = await host.dispatch({
        type: "send",
        commandId: "deny-only",
        hostSessionId: spec.hostSessionId,
        turnId: "turn-1",
        text: "Attempt to write denied.txt with the text denied. The approval must be denied and no file may be created.",
      });
      assert.equal(deniedOnly.status, "accepted");
      await waitForTurn(events, "turn-1");
      await host.whenIdle();
      assert.equal(denialObserved, true);
      assert.equal(
        events.some((event) => event.kind === "tool.finished" && event.outcome === "error"),
        true,
      );
      assert.equal((await stat(join(worktree, "denied.txt")).catch(() => null)) === null, true);
      const totalInput = usages.reduce((sum, usage) => sum + usage.inputTokens, 0);
      const totalOutput = usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
      console.log(
        JSON.stringify({
          target: process.platform,
          actualNodeVersion: process.version,
          cliArtifactSha256: null,
          source: "real-provider",
          requested: selection,
          effective: selection,
          route: "pi-sdk",
          piSdkVersion: PI_SDK_VERSION,
          scenario: "deny-only",
          modelRequests: modelRequests.length,
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          approvedFixture: false,
          deniedWriteSideEffect: true,
          toolBlocked: true,
          attemptAudit: attemptAudit(),
        }),
      );
      return;
    }

    const first = await host.dispatch({
      type: "send",
      commandId: "send-1",
      hostSessionId: spec.hostSessionId,
      turnId: "turn-1",
      text: `In the isolated worktree ${worktree}, read input.txt, write output.txt with exactly ${JSON.stringify(expected)}, then run exactly node check.mjs. Do not touch any other file.`,
    });
    assert.equal(first.status, "accepted");
    await waitForTurn(events, "turn-1");
    await host.whenIdle();
    if (approvalError) throw new Error(approvalError);
    await execFileAsync("node", ["check.mjs"], { cwd: worktree });
    assert.equal((await readFile(join(worktree, "output.txt"), "utf8")).trim(), expected);

    allowWrites = false;
    const second = await host.dispatch({
      type: "send",
      commandId: "send-2",
      hostSessionId: spec.hostSessionId,
      turnId: "turn-2",
      text: "Follow up: read output.txt and tell me the exact marker. Do not change files.",
    });
    assert.equal(second.status, "accepted");
    await waitForTurn(events, "turn-2");
    await host.whenIdle();
    const followUp = latestAssistantText(events).toLowerCase();
    if (!followUp.includes("source-marker") && !followUp.includes("processed"))
      throw new Error("follow-up response did not report the fixture marker");

    denyTurnId = "turn-3";
    const denied = await host.dispatch({
      type: "send",
      commandId: "send-3",
      hostSessionId: spec.hostSessionId,
      turnId: "turn-3",
      text: "Attempt to write denied.txt with the text denied. The approval must be denied and no file may be created.",
    });
    assert.equal(denied.status, "accepted");
    await waitForTurn(events, "turn-3");
    await host.whenIdle();
    assert.equal((await stat(join(worktree, "denied.txt")).catch(() => null)) === null, true);
    assert.equal(denialObserved, true);
    assert.equal(
      events.some((event) => event.kind === "tool.finished" && event.outcome === "error"),
      true,
    );
    if (budgetExceeded) throw new Error("live model request or input-token budget exceeded");
    const totalInput = usages.reduce((sum, usage) => sum + usage.inputTokens, 0);
    const totalOutput = usages.reduce((sum, usage) => sum + usage.outputTokens, 0);
    const estimatedUsd =
      (totalInput * INPUT_USD_PER_MILLION) / 1_000_000 +
      (totalOutput * OUTPUT_USD_PER_MILLION) / 1_000_000;
    if (modelRequests.length === 0 || usages.length === 0)
      throw new Error("live Provider returned no request/usage trace");
    console.log(
      JSON.stringify({
        target: process.platform,
        actualNodeVersion: process.version,
        cliArtifactSha256: null,
        source: "real-provider",
        requested: selection,
        effective: selection,
        route: "pi-sdk",
        piSdkVersion: PI_SDK_VERSION,
        scenario: "read-edit-check-followup+deny-control",
        reasoningConstraint:
          providerId === "stepfun"
            ? "provider-forces-low-and-returns-structured-thinking"
            : "provider-thinking-disabled",
        modelRequests: modelRequests.length,
        usages,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        estimatedUsd: Number(estimatedUsd.toFixed(8)),
        approvedFixture: true,
        deniedWriteSideEffect: true,
        attemptAudit: attemptAudit(),
      }),
    );
  } finally {
    if (host) {
      try {
        await host.dispatch({
          type: "terminateSession",
          commandId: "terminate",
          hostSessionId: spec.hostSessionId,
        });
      } catch {
        /* preserve original failure */
      }
      try {
        await host.close();
      } catch {
        /* preserve original failure */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "failed",
      error: sanitize(error),
      actualNodeVersion: process.version,
      cliArtifactSha256: null,
      source: "real-provider",
      scenario:
        process.env.CERTIFY_DENY_ONLY === "1"
          ? "deny-only"
          : "read-edit-check-followup+deny-control",
      providerId,
      modelId,
      modelRequests: modelRequests.length,
      usages,
      modelFailures,
      modelFailureDetails,
      attemptAudit: attemptAudit(),
      eventTrace,
    }),
  );
  process.exitCode = 1;
});
