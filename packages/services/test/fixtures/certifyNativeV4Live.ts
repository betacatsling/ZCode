/* eslint-disable max-lines -- bounded native live driver keeps provider setup and V4 lifecycle auditable. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ZCodeProtocolClient } from "../../src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "../../src/zcode-agent/zcodeStdioTransport.js";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  commandAckSchema,
  v4ConversationUsageResultSchema,
  v4ConversationRowsRangeResultSchema,
  v4ConversationSubscribeResultSchema,
  type TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  nativeBuiltinProviderConfigPath,
  nativeCliPath,
  nativeClientId,
  createNativeCheckScript,
  nativeExpectedOutput,
  prepareNativeFetchGuard,
  readNativeFetchAudit,
  type NativeConfigModel,
  type NativeFetchAudit,
  type NativeProviderMetadata,
} from "./certifyNativeV4Common.js";
import {
  NativeV4ConversationState,
  type CurrentPendingPermission,
} from "./certifyNativeV4ConversationState.js";
import {
  cleanupNativeFixtureChild,
  spawnNativeFixtureChild,
} from "./certifyNativeV4FakeProcess.js";
import {
  diagnoseNativeLiveToolRow,
  diagnoseNativeLiveTurn,
  nativeLiveTurnFailureReasons,
} from "./certifyNativeV4LiveDiagnostics.js";

const providerId = process.env.CERTIFY_NATIVE_LIVE_PROVIDER?.trim();
const modelId =
  process.env.CERTIFY_NATIVE_LIVE_MODEL?.trim() ||
  (providerId === "stepfun" ? "step-3.5-flash" : "deepseek-v4-flash");
const reasoningLevel = providerId === "stepfun" ? "low" : "off";
const scenario = process.env.CERTIFY_NATIVE_LIVE_SCENARIO?.trim() || "read-edit-check-followup";
const maxPhysicalFetches = scenario === "permission-deny-control" ? 6 : 16;
const maxInteractions = 8;
const turnDeadlineMs = 300_000;
const outputTokenLimit = 2_048;

interface PiModelsFile {
  providers?: Record<string, NativeProviderMetadata>;
}
interface NativeUsageAudit {
  modelRequestCount: number;
  modelErrorCount: number;
  inputTokens: number;
  outputTokens: number;
}
interface NativeArtifactEvidence {
  readonly outputBytesExact: boolean;
  readonly outputSha256: string | null;
  readonly expectedOutputSha256: string;
  readonly nonceMarkerMatches: boolean;
  readonly fixedCheckScriptUnchanged: boolean;
  readonly actualCheckScriptSha256: string | null;
  readonly expectedCheckScriptSha256: string;
  readonly outputStillExactAfterFollowup?: boolean;
  readonly nonceMarkerStillMatchesAfterFollowup?: boolean;
  readonly fixedCheckScriptStillUnchangedAfterFollowup?: boolean;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readFixtureBytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

function assertLiteralKey(provider: NativeProviderMetadata): void {
  const key = provider.apiKey ?? "";
  if (!key || key.startsWith("$") || key.startsWith("!") || key.startsWith("command:")) {
    throw new Error("native live provider requires a literal credential resolved before launch");
  }
}

const remoteAxonLookup = [
  "import json, pathlib",
  "p = pathlib.Path.home() / '.pi/agent/models.json'",
  "print(json.dumps(json.loads(p.read_text()).get('providers', {}).get('axonhub', {}), separators=(',', ':'))) ",
].join("\n");

async function readRemoteAxonProvider(alias: string): Promise<NativeProviderMetadata> {
  const child = spawn("ssh", [alias, "/usr/bin/python3", "-"], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.resume();
  child.stdin.end(remoteAxonLookup);
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  if (code !== 0) throw new Error("private Mac Axon provider lookup failed");
  const provider = JSON.parse(stdout) as NativeProviderMetadata;
  assertLiteralKey(provider);
  return provider;
}

async function readProviderMetadata(): Promise<{
  provider: NativeProviderMetadata;
  model: NativeConfigModel;
  origin: string;
}> {
  assert(providerId, "CERTIFY_NATIVE_LIVE_PROVIDER is required");
  const alias = process.env.CERTIFY_AXON_SSH_ALIAS?.trim();
  const provider = alias
    ? await readRemoteAxonProvider(alias)
    : (
        JSON.parse(
          await readFile(
            process.env.PI_MODELS_PATH?.trim() || join(homedir(), ".pi", "agent", "models.json"),
            { encoding: "utf8" },
          ),
        ) as PiModelsFile
      ).providers?.[providerId];
  if (!provider) throw new Error(`live provider metadata unavailable: ${providerId}`);
  assertLiteralKey(provider);
  const model = provider.models?.find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`live model metadata unavailable: ${providerId}/${modelId}`);
  if (model.maxTokens !== undefined && model.maxTokens < outputTokenLimit)
    throw new Error("live model output-token maximum is below the fixture response budget");
  if (!provider.baseUrl) throw new Error("live provider baseUrl unavailable");
  return { provider, model, origin: alias ? "private-ssh-memory" : "local-pi-models" };
}

function modelConfig(provider: NativeProviderMetadata, model: NativeConfigModel) {
  const api =
    provider.api === "anthropic-messages" ? "anthropic-messages" : "openai-chat-completions";
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: model.contextWindow ?? 128_000,
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
      reasoningLevel: {
        values: [reasoningLevel],
        map:
          api === "anthropic-messages"
            ? '{"thinking": {"type": "disabled"}}'
            : reasoningLevel === "low"
              ? '{"reasoning_effort": "low"}'
              : '{"reasoning_effort": "none"}',
      },
      maxOutputTokens: {
        max: Math.min(outputTokenLimit, model.maxTokens ?? outputTokenLimit),
        map: '{"max_tokens": maxOutputTokens}',
      },
    },
  };
}

async function writePersonalProviderConfig(
  root: string,
  provider: NativeProviderMetadata,
  model: NativeConfigModel,
): Promise<string> {
  assert(providerId);
  assert(provider.baseUrl);
  const path = join(root, "provider-config.json");
  const apiType =
    provider.api === "anthropic-messages" ? "anthropic-messages" : "openai-chat-completions";
  // Pi Provider Config 的 authHeader=true 表示显式补 Bearer 头；此前 native fixture 只复制 headers，
  // 会让同一份合法配置在 native 路由丢失认证语义。
  const apiHeaders = provider.authHeader
    ? { Authorization: `Bearer ${provider.apiKey}`, ...provider.headers }
    : provider.headers;
  const config = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId,
            providerName: providerId,
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: provider.apiKey },
              api: {
                type: apiType,
                baseUrl: provider.baseUrl,
                ...(apiHeaders ? { headers: apiHeaders } : {}),
              },
              personalModelIds: [model.id],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId, modelId: model.id, config: modelConfig(provider, model) },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId, modelId: model.id, options: { reasoningLevel } },
    },
  };
  await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  return path;
}

function commandEnvelope(
  sessionId: string | null,
  type: string,
  payload: unknown,
): Record<string, unknown> {
  return {
    commandId: randomUUID(),
    clientId: nativeClientId,
    sessionId,
    type,
    payload,
    issuedAt: Date.now(),
  };
}

async function sendCommand(
  client: ZCodeProtocolClient,
  sessionId: string | null,
  type: string,
  payload: unknown,
): Promise<unknown> {
  return client.request(
    V4_METHODS.command,
    commandEnvelope(sessionId, type, payload),
    commandAckSchema,
  );
}

async function waitForInitialSnapshot(conversation: NativeV4ConversationState): Promise<void> {
  while (!conversation.snapshot) {
    const version = conversation.changeVersion;
    conversation.assertHealthy();
    if (conversation.snapshot) return;
    await conversation.waitForChange(version);
  }
}

function nativeAttemptAudit(usage: NativeUsageAudit | undefined, fetchAudit?: NativeFetchAudit) {
  return {
    runtimeLogicalModelAttempts: usage?.modelRequestCount ?? null,
    logicalFetchAttempts: fetchAudit?.logicalFetchAttempts ?? null,
    emittedFetches: fetchAudit?.nativeFetchInvocations ?? null,
    httpResponses: fetchAudit?.httpResponses ?? null,
    httpErrorResponses: fetchAudit?.httpErrorResponses ?? null,
    fetchFailures: fetchAudit?.fetchFailures ?? null,
    cancelledFetches: fetchAudit?.cancelledFetches ?? null,
    guardBlockedBeforeSend: fetchAudit?.blockedBeforeSend ?? 0,
    unknownFetchOutcomes: fetchAudit?.unknownOutcomes ?? null,
    runtimeModelErrors: usage?.modelErrorCount ?? null,
    usageGranularity: "session-aggregate",
    fetchAudit,
  };
}

function estimatedStepFunUsd(usage: NativeUsageAudit): number {
  return (usage.inputTokens * 0.1) / 1_000_000 + (usage.outputTokens * 0.3) / 1_000_000;
}

function rowInput(row: {
  input?: unknown;
  inputText: string;
}): Record<string, unknown> | undefined {
  if (row.input && typeof row.input === "object" && !Array.isArray(row.input))
    return row.input as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.inputText);
    return objectRecord(parsed);
  } catch {
    return undefined;
  }
}

function safeLiveFailureClass(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("native operation-policy rejected")) return "operation-policy-rejected";
  if (message.includes("native required final outcome missing"))
    return "missing-required-final-outcome";
  if (message.includes("native live permission was outside")) return "permission-scope-rejected";
  if (message.includes("fetch guard") || message.includes("fetch budget")) return "fetch-guard";
  if (
    message.includes("completedSuccess".toLowerCase()) ||
    message.includes("must read") ||
    message.includes("must edit") ||
    message.includes("must run") ||
    message.includes("required outcome")
  )
    return "required-outcome";
  if (error instanceof Error && error.name === "AssertionError") return "assertion";
  return "unclassified";
}

async function flushLiveFailureAudit(root: string, audit: unknown): Promise<void> {
  const record = objectRecord(audit) ?? {};
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let tempFileFlushed = false;
  try {
    file = await open(join(root, "native-live-failure-audit.jsonl"), "a", 0o600);
    await file.write(`${JSON.stringify(record)}\n`);
    await file.sync();
    tempFileFlushed = true;
  } catch {
    // The flushed stderr line below is the retained attempt record if temp IO fails.
  } finally {
    await file?.close();
  }
  const line = `${JSON.stringify({ ...record, tempFileFlushed })}\n`;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    process.stderr.write(line, (error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function mayApproveFullScenarioTool(
  row: CurrentPendingPermission["toolRow"],
  workspace: string,
): boolean {
  const diagnostic = diagnoseNativeLiveToolRow(row, workspace);
  return (
    row.status === "pendingApproval" && diagnostic.classification === "allowed-operation-incomplete"
  );
}

export async function runNativeV4Live(): Promise<void> {
  assert(providerId, "CERTIFY_NATIVE_LIVE_PROVIDER is required");
  assert.ok(providerId === "stepfun" || providerId === "axonhub", "unsupported live Provider");
  assert.equal(
    modelId,
    providerId === "stepfun" ? "step-3.5-flash" : "deepseek-v4-flash",
    "native live run must use the authorized fixture model",
  );
  assert.equal(process.version, "v24.14.0", "native live run requires the pinned Node toolchain");
  assert.equal(
    process.env.CERTIFY_NATIVE_V4,
    "1",
    "set CERTIFY_NATIVE_V4=1 for the explicit native probe",
  );
  assert.ok(
    scenario === "read-edit-check-followup" || scenario === "permission-deny-control",
    `unsupported native live scenario: ${scenario}`,
  );
  await stat(nativeCliPath);
  await stat(nativeBuiltinProviderConfigPath);
  const metadata = await readProviderMetadata();
  const cliArtifactSha256 = createHash("sha256")
    .update(await readFile(nativeCliPath))
    .digest("hex");
  const root = await mkdtemp(join(tmpdir(), `zcode-native-live-${providerId}-`));
  const workspace = join(root, "workspace");
  const dataBaseDir = join(root, "data");
  const home = join(root, "home");
  const sentinelPath = join(root, "native-denied-sentinel.txt");
  const fetchGuard = await prepareNativeFetchGuard(root, maxPhysicalFetches);
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(dataBaseDir, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(workspace, "input.txt"), "native live marker\n", { mode: 0o600 });
  const checkMarkerPath = join(workspace, ".native-check-success");
  const checkNonce = randomUUID();
  const checkScript = createNativeCheckScript(workspace, checkMarkerPath, checkNonce);
  const checkScriptSha256 = createHash("sha256").update(checkScript).digest("hex");
  await writeFile(join(workspace, "check.mjs"), checkScript, { mode: 0o700 });
  await assert.rejects(stat(checkMarkerPath), { code: "ENOENT" });
  const personalConfigPath = await writePersonalProviderConfig(
    root,
    metadata.provider,
    metadata.model,
  );
  const localProvider = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/u.test(
    metadata.provider.baseUrl ?? "",
  );
  const ownedChild = spawnNativeFixtureChild(
    process.execPath,
    [nativeCliPath, "app-server", "--stdio"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        NODE_ENV: "test",
        ZCODE_DATA_BASE_DIR: dataBaseDir,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: nativeBuiltinProviderConfigPath,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalConfigPath,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, fetchGuard.nodeOptions].filter(Boolean).join(" "),
        ZCODE_NATIVE_FETCH_GUARD_LOG: fetchGuard.auditPath,
        ...(localProvider
          ? {
              HTTP_PROXY: "",
              http_proxy: "",
              HTTPS_PROXY: "",
              https_proxy: "",
              ALL_PROXY: "",
              all_proxy: "",
              NO_PROXY: "127.0.0.1,localhost",
              no_proxy: "127.0.0.1,localhost",
            }
          : {}),
      },
    },
  );
  const child = ownedChild.process;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-6_000);
  });
  const transport = new ZCodeStdioTransport(child);
  const client = new ZCodeProtocolClient(transport, { requestTimeoutMs: 45_000 });
  let conversation: NativeV4ConversationState | undefined;
  let deniedInteractionId: string | undefined;
  let stopCommandSent = false;
  let acceptedModelSends = 0;
  let lastTurnCountBeforeSend = 0;
  let lastUsage: NativeUsageAudit | undefined;
  const interactionOrder: string[] = [];
  const unsubscribeNotification = client.onNotification((notification) => {
    if (notification.method !== V4_NOTIFICATIONS.conversationFrame) return;
    try {
      conversation?.acceptNotification(notification.params);
    } catch (error) {
      conversation?.reportFailure(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const unsubscribeRequest = client.onRequest((request) => {
    if (request.method === "session/requestRuntimePreferences") {
      void client.respond(request.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
        modelContextBudgetStrategy: "preflight-v1",
      });
    } else if (
      request.method === "interaction/requestPermission" ||
      request.method === "interaction/requestUserInput"
    ) {
      // 由 V4 resolveInteraction 完成权限应答；提前拒绝 legacy 请求会绕过待审批状态。
      return;
    } else
      void client.respondError(request.id, {
        code: -32601,
        message: "native live request unsupported",
      });
  });
  let sessionId = "";
  let activeTurnId: string | undefined;
  let activeTurnPhase: "permission-deny-control" | "full" | "followup" | undefined;
  let fullArtifactEvidence: NativeArtifactEvidence | undefined;
  let interactionsHandled = 0;
  const readUsage = async (): Promise<NativeUsageAudit> => {
    const usage = await client.request(
      V4_METHODS.conversationUsage,
      { sessionId },
      v4ConversationUsageResultSchema,
    );
    lastUsage = usage;
    return usage;
  };
  const readRows = () =>
    client.request(
      V4_METHODS.conversationRowsRange,
      { sessionId, limit: 200 },
      v4ConversationRowsRangeResultSchema,
    );
  const readTurnCount = async (): Promise<number> =>
    (await readRows()).rows.filter((row) => row.kind === "turnHeader").length;
  const currentConversation = (): NativeV4ConversationState => {
    if (!conversation) throw new Error("native live conversation subscription is not configured");
    return conversation;
  };
  const turnHeaderAfter = (previousCount: number) => {
    const headers = currentConversation().turnHeaders();
    return headers.length > previousCount ? headers.at(-1) : undefined;
  };
  const waitForStateChange = async (version: number, timeoutMs: number): Promise<void> => {
    try {
      await currentConversation().waitForChange(version, timeoutMs);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "native V4 conversation state did not advance"
      )
        return;
      throw error;
    }
  };
  const waitForNewTurn = async (previousCount: number) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const state = currentConversation();
      const version = state.changeVersion;
      state.assertHealthy();
      const header = turnHeaderAfter(previousCount);
      if (header) {
        assert.equal(header.state, "running", "new native live turn must be running");
        return header;
      }
      await waitForStateChange(version, Math.min(45_000, deadline - Date.now()));
    }
    throw new Error("native live turn did not appear in the subscribed snapshot");
  };
  const waitForPendingPermission = async (
    turnId: string,
    timeoutMs = 45_000,
  ): Promise<CurrentPendingPermission> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = currentConversation();
      const version = state.changeVersion;
      state.assertHealthy();
      const pending = state.pendingPermissionsForTurn(turnId)[0];
      if (pending) return pending;
      const header = state.turnHeaders().find((row) => row.turnId === turnId);
      if (header && header.state !== "running")
        throw new Error("native live turn ended without a backend permission interaction");
      await waitForStateChange(version, Math.min(45_000, deadline - Date.now()));
    }
    throw new Error("native live permission interaction timed out");
  };
  const stopTurn = async (): Promise<void> => {
    if (stopCommandSent) return;
    const ack = objectRecord(await sendCommand(client, sessionId, "stop", {}));
    assert.equal(ack?.status, "accepted", JSON.stringify(ack));
    stopCommandSent = true;
  };
  const resolveExpectedPermission = async (pending: CurrentPendingPermission): Promise<void> => {
    assert.equal(
      scenario,
      "read-edit-check-followup",
      "deny-control must never auto-approve an interaction",
    );
    const { interaction, toolRow } = pending;
    assert.equal(interaction.kind, "permission");
    interactionsHandled += 1;
    if (interactionsHandled > maxInteractions)
      throw new Error("native live interaction cap exceeded");
    assert.ok(
      mayApproveFullScenarioTool(toolRow, workspace),
      "native live permission was outside the exact temporary fixture operations",
    );
    const ack = objectRecord(
      await sendCommand(client, sessionId, "resolveInteraction", {
        interactionId: interaction.interactionId,
        answer: { optionId: "allowOnce" },
      }),
    );
    assert.equal(ack?.status, "accepted", JSON.stringify(ack));
  };
  const assertWithinFetchLimit = async (): Promise<void> => {
    const audit = await readNativeFetchAudit(fetchGuard.auditPath);
    if (audit.blockedBeforeSend > 0) {
      await stopTurn();
      throw new Error(`native Provider fetch guard blocked a send at limit ${maxPhysicalFetches}`);
    }
    assert.ok(audit.nativeFetchInvocations <= maxPhysicalFetches);
  };
  const waitForTerminalTurn = async (): Promise<
    "completedSuccess" | "failed" | "completedInterrupted"
  > => {
    const deadline = Date.now() + turnDeadlineMs;
    const resolvedInteractions = new Set<string>();
    while (Date.now() < deadline) {
      await assertWithinFetchLimit();
      const state = currentConversation();
      const version = state.changeVersion;
      state.assertHealthy();
      const latest = turnHeaderAfter(lastTurnCountBeforeSend);
      if (latest) {
        activeTurnId = latest.turnId;
        for (const pending of state.pendingPermissionsForTurn(latest.turnId)) {
          if (resolvedInteractions.has(pending.interaction.interactionId)) continue;
          if (scenario === "permission-deny-control") {
            assert.equal(
              pending.interaction.interactionId,
              deniedInteractionId,
              "deny-control received an unexpected backend permission interaction",
            );
            continue;
          }
          await resolveExpectedPermission(pending);
          resolvedInteractions.add(pending.interaction.interactionId);
        }
        if (
          latest.state === "completedSuccess" ||
          latest.state === "failed" ||
          latest.state === "completedInterrupted"
        )
          return latest.state;
      }
      await waitForStateChange(version, Math.min(45_000, deadline - Date.now()));
    }
    throw new Error("native live turn deadline exceeded");
  };
  try {
    const mode = scenario === "permission-deny-control" ? "build" : "edit";
    const create = objectRecord(
      await sendCommand(client, null, "createSession", {
        workspaceId: workspace,
        config: { mode, modelSelection: { providerId, modelId, options: { reasoningLevel } } },
      }),
    );
    const result = objectRecord(create?.result);
    assert.equal(create?.status, "accepted", JSON.stringify(create));
    assert.equal(typeof result?.sessionId, "string", JSON.stringify(create));
    sessionId = result!.sessionId as string;
    const activeConversation = new NativeV4ConversationState(sessionId);
    conversation = activeConversation;
    const topic = `conversation/${sessionId}`;
    const subscribeResult = await client.request(
      V4_METHODS.conversationSubscribe,
      {
        topic,
        connectionId: nativeClientId,
        clientMode: "desktop-continuous",
        workspace: { workspacePath: workspace, workspaceKey: workspace },
        visibility: "foreground",
      },
      v4ConversationSubscribeResultSchema,
    );
    assert.equal(subscribeResult.ack.mode, "snapshot");
    activeConversation.configureSubscription(
      subscribeResult.ack.subscriptionId,
      subscribeResult.ack.logEpoch,
    );
    await waitForInitialSnapshot(activeConversation);
    if (scenario === "permission-deny-control") {
      activeTurnId = undefined;
      activeTurnPhase = "permission-deny-control";
      lastTurnCountBeforeSend = await readTurnCount();
      const send = objectRecord(
        await sendCommand(client, sessionId, "sendText", {
          text: `Use the Write tool exactly once to attempt creating ${sentinelPath} with content native denied sentinel. Do not ask a question or use another tool.`,
          requestedDelivery: "startNow",
          mode,
          modelSelection: { providerId, modelId, options: { reasoningLevel } },
        }),
      );
      assert.equal(send?.status, "accepted", JSON.stringify(send));
      acceptedModelSends += 1;
      const denyTurn = await waitForNewTurn(lastTurnCountBeforeSend);
      const pending = await waitForPendingPermission(denyTurn.turnId);
      const interaction = pending.interaction;
      const pendingWrite = pending.toolRow;
      assert.equal(interaction.kind, "permission");
      assert.equal(pendingWrite.turnId, denyTurn.turnId);
      assert.equal(pendingWrite.toolName, "Write");
      assert.equal(pendingWrite.status, "pendingApproval");
      const writeInput = rowInput(pendingWrite);
      assert.equal(
        resolve(
          workspace,
          String(writeInput?.file_path ?? writeInput?.path ?? writeInput?.filePath ?? ""),
        ),
        resolve(sentinelPath),
        "deny-control must request only its exact external sentinel path",
      );
      deniedInteractionId = interaction.interactionId;
      interactionOrder.push("backend-permission-pending");
      const decline = objectRecord(
        await sendCommand(client, sessionId, "resolveInteraction", {
          interactionId: interaction.interactionId,
          answer: { optionId: "deny" },
        }),
      );
      assert.equal(decline?.status, "accepted", JSON.stringify(decline));
      interactionOrder.push("declined");
      const blockedDeadline = Date.now() + 15_000;
      let blockedRow: typeof pendingWrite | undefined;
      while (Date.now() < blockedDeadline) {
        const version = activeConversation.changeVersion;
        activeConversation.assertHealthy();
        const updated = activeConversation.snapshot?.rows.window.find(
          (row) => row.kind === "toolCall" && row.toolCallId === pendingWrite.toolCallId,
        );
        if (updated?.kind === "toolCall" && updated.status === "error") {
          blockedRow = updated;
          break;
        }
        await waitForStateChange(version, Math.min(15_000, blockedDeadline - Date.now()));
      }
      assert.equal(blockedRow?.kind, "toolCall");
      assert.equal(blockedRow.toolCallId, pendingWrite.toolCallId);
      assert.equal(blockedRow.approvalInteractionId, interaction.interactionId);
      assert.equal(blockedRow.status, "error", "declined permission must block the tool call");
      interactionOrder.push("tool-blocked");
      await assert.rejects(stat(sentinelPath), { code: "ENOENT" });
      interactionOrder.push("sentinel-absent");
      await stopTurn();
      interactionOrder.push("cancelled");
      const turnState = await waitForTerminalTurn();
      assert.equal(turnState, "completedInterrupted");
      const usage = await readUsage();
      const fetchAudit = await readNativeFetchAudit(fetchGuard.auditPath);
      assert.ok(
        fetchAudit.logicalFetchAttempts > 0,
        "native fetch guard must observe real Provider traffic",
      );
      assert.ok(
        fetchAudit.nativeFetchInvocations <= maxPhysicalFetches,
        "native fetch guard must cap Provider sends",
      );
      assert.equal(fetchAudit.blockedBeforeSend, 0, "permission control exceeded its fetch budget");
      assert.equal(
        fetchAudit.unknownOutcomes,
        0,
        "permission control left an unresolved fetch audit",
      );
      console.log(
        JSON.stringify({
          status: "native-v4-live-permission-deny-pass",
          actualNodeVersion: process.version,
          cliArtifactSha256,
          spawnPid: ownedChild.pid,
          source: "real-provider",
          scenario,
          providerId,
          modelId,
          reasoningLevel,
          maxOutputTokens: outputTokenLimit,
          physicalFetchLimit: maxPhysicalFetches,
          target: process.platform,
          configOrigin: metadata.origin,
          mode,
          attemptAudit: nativeAttemptAudit(usage, fetchAudit),
          usage: {
            modelRequestCount: usage.modelRequestCount,
            modelErrorCount: usage.modelErrorCount,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          },
          interactionOrder,
          turnId: denyTurn.turnId,
          logEpoch: activeConversation.snapshot?.logEpoch,
          interactionId: interaction.interactionId,
          toolCallId: pendingWrite.toolCallId,
          deniedToolStatus: blockedRow.status,
          deniedWriteSideEffect: false,
          deniedArtifact: { sentinelAbsent: true },
          cancellation: "stop-command-after-block",
          costEstimate:
            providerId === "stepfun"
              ? {
                  type: "planning-only",
                  usd: Number(estimatedStepFunUsd(usage).toFixed(8)),
                  rmbAt8PerUsd: Number((estimatedStepFunUsd(usage) * 8).toFixed(8)),
                }
              : { type: "unknown-proxy-rate" },
        }),
      );
      return;
    }

    activeTurnId = undefined;
    activeTurnPhase = "full";
    lastTurnCountBeforeSend = await readTurnCount();
    const send = objectRecord(
      await sendCommand(client, sessionId, "sendText", {
        text: "This is a small fixture. You may check whether output.txt exists first; if it is absent, continue. Read input.txt, then Write or Edit output.txt so it contains exactly native live output followed by one newline. Call Bash exactly once to run the supplied fixed check script with exactly `node ./check.mjs`; after it finishes, reply without further tool calls. Do not plan, delegate, or modify check.mjs or other files. Reply with one short check result.",
        requestedDelivery: "startNow",
        mode,
        modelSelection: { providerId, modelId, options: { reasoningLevel } },
      }),
    );
    assert.equal(send?.status, "accepted", JSON.stringify(send));
    acceptedModelSends += 1;
    let turnState = await waitForTerminalTurn();
    assert.equal(turnState, "completedSuccess", `first native live turn ended ${turnState}`);
    const fullSnapshot = currentConversation().snapshot;
    assert.ok(activeTurnId, "native full turn must have an active turn ID");
    assert.ok(fullSnapshot, "native full turn must have a current snapshot");
    const fullTurnAudit = diagnoseNativeLiveTurn({
      rows: fullSnapshot.rows.window,
      currentTurnId: activeTurnId,
      logEpoch: fullSnapshot.logEpoch,
      workspace,
    });
    const [outputBytes, markerBytes, currentCheckScriptBytes] = await Promise.all([
      readFixtureBytes(join(workspace, "output.txt")),
      readFixtureBytes(checkMarkerPath),
      readFixtureBytes(join(workspace, "check.mjs")),
    ]);
    const expectedOutputBytes = Buffer.from(nativeExpectedOutput);
    const expectedCheckScriptBytes = Buffer.from(checkScript);
    fullArtifactEvidence = {
      outputBytesExact: outputBytes?.equals(expectedOutputBytes) ?? false,
      outputSha256: outputBytes ? createHash("sha256").update(outputBytes).digest("hex") : null,
      expectedOutputSha256: createHash("sha256").update(expectedOutputBytes).digest("hex"),
      nonceMarkerMatches: markerBytes?.equals(Buffer.from(`${checkNonce}\n`)) ?? false,
      fixedCheckScriptUnchanged: currentCheckScriptBytes?.equals(expectedCheckScriptBytes) ?? false,
      actualCheckScriptSha256: currentCheckScriptBytes
        ? createHash("sha256").update(currentCheckScriptBytes).digest("hex")
        : null,
      expectedCheckScriptSha256: checkScriptSha256,
    };
    assert.equal(fullArtifactEvidence.outputBytesExact, true, "output bytes must match exactly");
    assert.equal(fullArtifactEvidence.nonceMarkerMatches, true, "nonce marker must match exactly");
    assert.equal(
      fullArtifactEvidence.fixedCheckScriptUnchanged,
      true,
      "model must leave the fixed check script unchanged",
    );
    const fullTurnFailures = nativeLiveTurnFailureReasons(fullTurnAudit);
    if (fullTurnFailures.some((reason) => !reason.startsWith("missing-required-final-outcome:")))
      throw new Error("native operation-policy rejected");
    if (fullTurnFailures.length > 0) throw new Error("native required final outcome missing");
    activeTurnId = undefined;
    activeTurnPhase = "followup";
    lastTurnCountBeforeSend = await readTurnCount();
    const followup = objectRecord(
      await sendCommand(client, sessionId, "sendText", {
        text: "Follow up: state whether node check.mjs passed. Do not change files.",
        requestedDelivery: "startNow",
        mode,
        modelSelection: { providerId, modelId, options: { reasoningLevel } },
      }),
    );
    assert.equal(followup?.status, "accepted", JSON.stringify(followup));
    acceptedModelSends += 1;
    turnState = await waitForTerminalTurn();
    assert.equal(turnState, "completedSuccess", `native follow-up turn ended ${turnState}`);
    const followupTurnId = activeTurnId;
    assert.ok(followupTurnId, "native follow-up must have an active turn ID");
    const followupRows = currentConversation().snapshot?.rows.window.filter(
      (row) => row.turnId === followupTurnId,
    );
    assert.equal(
      followupRows?.some((row) => row.kind === "toolCall") ?? false,
      false,
      "native follow-up must complete without tool calls",
    );
    const latestAssistantText = followupRows?.filter((row) => row.kind === "assistantText").at(-1);
    assert.ok(
      latestAssistantText?.kind === "assistantText" && latestAssistantText.text.trim().length > 0,
      "native follow-up must return assistant text",
    );
    assert.ok(fullArtifactEvidence);
    const [followupOutputBytes, followupMarkerBytes, followupCheckBytes] = await Promise.all([
      readFixtureBytes(join(workspace, "output.txt")),
      readFixtureBytes(checkMarkerPath),
      readFixtureBytes(join(workspace, "check.mjs")),
    ]);
    fullArtifactEvidence = {
      ...fullArtifactEvidence,
      outputStillExactAfterFollowup:
        followupOutputBytes?.equals(Buffer.from(nativeExpectedOutput)) ?? false,
      nonceMarkerStillMatchesAfterFollowup:
        followupMarkerBytes?.equals(Buffer.from(`${checkNonce}\n`)) ?? false,
      fixedCheckScriptStillUnchangedAfterFollowup:
        followupCheckBytes?.equals(Buffer.from(checkScript)) ?? false,
    };
    assert.equal(
      fullArtifactEvidence.outputStillExactAfterFollowup,
      true,
      "follow-up must leave output bytes unchanged",
    );
    assert.equal(
      fullArtifactEvidence.nonceMarkerStillMatchesAfterFollowup,
      true,
      "follow-up must leave the nonce marker unchanged",
    );
    assert.equal(
      fullArtifactEvidence.fixedCheckScriptStillUnchangedAfterFollowup,
      true,
      "follow-up must leave the fixed check script unchanged",
    );
    const usage = await readUsage();
    const fetchAudit = await readNativeFetchAudit(fetchGuard.auditPath);
    assert.ok(fetchAudit.logicalFetchAttempts <= maxPhysicalFetches);
    assert.ok(fetchAudit.nativeFetchInvocations <= maxPhysicalFetches);
    assert.equal(fetchAudit.blockedBeforeSend, 0, "native full run exceeded its fetch budget");
    assert.equal(fetchAudit.unknownOutcomes, 0, "native full run left an unresolved fetch audit");
    assert.ok(fullArtifactEvidence, "native full artifact checks must complete before follow-up");
    const stepFunEstimate = providerId === "stepfun" ? estimatedStepFunUsd(usage) : undefined;
    console.log(
      JSON.stringify({
        status: "native-v4-live-pass",
        actualNodeVersion: process.version,
        cliArtifactSha256,
        spawnPid: ownedChild.pid,
        source: "real-provider",
        scenario,
        providerId,
        modelId,
        reasoningLevel,
        maxOutputTokens: outputTokenLimit,
        physicalFetchLimit: maxPhysicalFetches,
        target: process.platform,
        configOrigin: metadata.origin,
        mode,
        attemptAudit: nativeAttemptAudit(usage, fetchAudit),
        fullTurnAudit,
        followup: {
          turnId: followupTurnId,
          completedSuccess: true,
          noToolCalls: true,
          terminalAssistantText: true,
          outputStillExact: fullArtifactEvidence.outputStillExactAfterFollowup,
        },
        usage: {
          modelRequestCount: usage.modelRequestCount,
          modelErrorCount: usage.modelErrorCount,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
        interactions: interactionsHandled,
        approvalEvidence: "not-established-by-edit-mode-auto-permissions",
        checkEvidence: {
          successfulBashToolRow: true,
          recognizedCommand: true,
          nonceMarkerVerified: true,
          fixedCheckScriptUnchanged: true,
        },
        completedScenario: ["read-input", "edit-output", "bash-check", "follow-up"],
        output: "output.txt",
        artifacts: {
          ...fullArtifactEvidence,
          nonceMarkerVerified: fullArtifactEvidence.nonceMarkerMatches,
        },
        test: "node ./check.mjs",
        costEstimate:
          stepFunEstimate === undefined
            ? { type: "unknown-proxy-rate" }
            : {
                type: "planning-only",
                usd: Number(stepFunEstimate.toFixed(8)),
                rmbAt8PerUsd: Number((stepFunEstimate * 8).toFixed(8)),
              },
      }),
    );
  } catch (error) {
    if (sessionId && !stopCommandSent) await stopTurn().catch(() => undefined);
    if (sessionId) {
      await waitForTerminalTurn().catch(() => undefined);
      await readUsage().catch(() => undefined);
    }
    const fetchAudit = await readNativeFetchAudit(fetchGuard.auditPath).catch(() => undefined);
    const snapshot = conversation?.snapshot;
    const currentTurnId = activeTurnId ?? turnHeaderAfter(lastTurnCountBeforeSend)?.turnId;
    const currentTurnRows = currentTurnId
      ? (snapshot?.rows.window.filter((row) => row.turnId === currentTurnId) ?? [])
      : [];
    const toolDiagnostics = currentTurnRows
      .filter((row) => row.kind === "toolCall")
      .map((row) => diagnoseNativeLiveToolRow(row, workspace));
    const turnDiagnostic =
      activeTurnPhase === "full" && currentTurnId && snapshot
        ? diagnoseNativeLiveTurn({
            rows: snapshot.rows.window,
            currentTurnId,
            logEpoch: snapshot.logEpoch,
            workspace,
          })
        : undefined;
    const fullTurnFailureReasons = turnDiagnostic
      ? nativeLiveTurnFailureReasons(turnDiagnostic)
      : [];
    const currentTurnHeader = currentTurnRows.find(
      (row): row is TurnHeaderRow => row.kind === "turnHeader",
    );
    const followupOutcome =
      activeTurnPhase === "followup"
        ? {
            completedSuccess: currentTurnHeader?.state === "completedSuccess",
            noToolCalls: toolDiagnostics.length === 0,
            terminalAssistantText: currentTurnRows.some(
              (row) =>
                row.kind === "assistantText" &&
                row.state === "complete" &&
                row.text.trim().length > 0,
            ),
            missing: [] as string[],
          }
        : undefined;
    if (followupOutcome) {
      if (!followupOutcome.completedSuccess)
        followupOutcome.missing.push("follow-up-completed-success");
      if (!followupOutcome.noToolCalls) followupOutcome.missing.push("follow-up-no-tool-calls");
      if (!followupOutcome.terminalAssistantText)
        followupOutcome.missing.push("follow-up-terminal-assistant-text");
    }
    const missingRequiredFinalOutcome =
      turnDiagnostic?.requiredOutcome.missing ??
      followupOutcome?.missing ??
      (currentTurnId ? [] : ["current-turn-not-observed"]);
    const failureAudit = {
      status: "native-v4-live-failed",
      actualNodeVersion: process.version,
      cliArtifactSha256,
      source: "real-provider",
      scenario,
      providerId,
      modelId,
      reasoningLevel,
      maxOutputTokens: outputTokenLimit,
      physicalFetchLimit: maxPhysicalFetches,
      target: process.platform,
      configOrigin: metadata.origin,
      spawnPid: ownedChild.pid,
      acceptedModelSends,
      attemptAudit: nativeAttemptAudit(lastUsage, fetchAudit),
      ...(lastUsage
        ? {
            usage: {
              modelRequestCount: lastUsage.modelRequestCount,
              modelErrorCount: lastUsage.modelErrorCount,
              inputTokens: lastUsage.inputTokens,
              outputTokens: lastUsage.outputTokens,
            },
          }
        : {}),
      unknownUsage: lastUsage === undefined,
      currentTurn: {
        turnId: currentTurnId?.slice(0, 128) ?? null,
        logEpoch: snapshot?.logEpoch.slice(0, 128) ?? null,
        phase: activeTurnPhase ?? null,
        turnStatus: currentTurnHeader?.state ?? null,
      },
      toolDiagnostics,
      ...(turnDiagnostic ? { requiredOutcome: turnDiagnostic.requiredOutcome } : {}),
      operationPolicyFailureReasons: fullTurnFailureReasons.filter(
        (reason) => !reason.startsWith("missing-required-final-outcome:"),
      ),
      ...(followupOutcome ? { followupOutcome } : {}),
      artifactEvidence: fullArtifactEvidence ?? null,
      missingRequiredFinalOutcome,
      interactionOrder,
      stopCommandSent,
      errorClass: safeLiveFailureClass(error),
      childStderr: { captured: stderr.length > 0, boundedBytes: stderr.length },
    };
    await flushLiveFailureAudit(root, failureAudit).catch(() => {
      process.exitCode = 1;
    });
    throw new Error("native live certification failed; redacted attempt audit emitted");
  } finally {
    unsubscribeNotification.dispose();
    unsubscribeRequest.dispose();
    const cleanup = await cleanupNativeFixtureChild(ownedChild, client);
    const childProcessClosed =
      ownedChild.process.exitCode !== null || ownedChild.process.signalCode !== null;
    let isolatedRootRemoved = false;
    try {
      await rm(root, { recursive: true, force: true });
      await stat(root).then(
        () => undefined,
        (removeError: unknown) => {
          if (
            removeError &&
            typeof removeError === "object" &&
            "code" in removeError &&
            removeError.code === "ENOENT"
          )
            isolatedRootRemoved = true;
        },
      );
    } catch {
      isolatedRootRemoved = false;
    }
    console.log(
      JSON.stringify({
        event: "native-v4-live-child-cleanup",
        spawnPid: ownedChild.pid,
        cleanup: {
          exitCode: cleanup.exitCode,
          signal: cleanup.signal,
          normal: cleanup.normal,
          childProcessClosed,
          isolatedRootRemoved,
          forcedTermination: cleanup.forcedTermination,
          transportCleanupFailed: Boolean(cleanup.transportCleanupError),
        },
      }),
    );
    if (!cleanup.normal || !childProcessClosed || !isolatedRootRemoved) process.exitCode = 1;
  }
}
