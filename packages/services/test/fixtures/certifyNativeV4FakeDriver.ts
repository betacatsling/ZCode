import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  v4ConversationSubscribeResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolClient } from "../../src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "../../src/zcode-agent/zcodeStdioTransport.js";
import {
  createNativeCheckScript,
  nativeBuiltinProviderConfigPath,
  nativeCliPath,
  nativeClientId,
  nativeExpectedOutput,
  nativeFakeModelId,
  nativeFakeOutputTokenLimit,
  nativeFakeProviderId,
  prepareNativeFetchGuard,
  readNativeFetchAudit,
  writeNativeFakeProviderConfig,
} from "./certifyNativeV4Common.js";
import { runNativeV4OfflineChecks } from "./certifyNativeV4OfflineChecks.js";
import {
  buildNativeFakeReport,
  nativeFakeWorkspaceFiles,
  requestHasFunctionTools,
  safeFakeFailureClass,
  summarizeFakeRequests,
} from "./certifyNativeV4FakeDiagnostics.js";
import {
  cleanupNativeFixtureChild,
  fakeNativeChildEnvironment,
  spawnNativeFixtureChild,
  type ChildCleanupResult,
  type FixtureChild,
} from "./certifyNativeV4FakeProcess.js";
import { assertScenarioHistory } from "./certifyNativeV4FakeAssertions.js";
import { NativeV4ConversationState } from "./certifyNativeV4ConversationState.js";
import { diagnoseNativeLiveToolRow } from "./certifyNativeV4LiveDiagnostics.js";
import { startFakeGateway } from "./certifyNativeV4FakeGateway.js";
import { resultSessionId, sendNativeCommand } from "./certifyNativeV4FakeProtocol.js";
import {
  runNativeDenyScenario,
  runNativeFollowupScenario,
  runNativeFullScenario,
  runNativeStopScenario,
  type NativeFakeScenarioResult,
} from "./certifyNativeV4FakeScenarios.js";

async function waitForInitialSnapshot(conversation: NativeV4ConversationState): Promise<void> {
  while (!conversation.snapshot) {
    const version = conversation.changeVersion;
    conversation.assertHealthy();
    if (conversation.snapshot) return;
    await conversation.waitForChange(version);
  }
}

async function main(): Promise<void> {
  assert.equal(
    process.env.CERTIFY_NATIVE_V4 === "1" || process.env.CERTIFY_NATIVE_MODE === "fake",
    true,
    "set CERTIFY_NATIVE_V4=1 for the explicit native probe",
  );
  await stat(nativeCliPath);
  await stat(nativeBuiltinProviderConfigPath);

  const cliArtifactSha256 = createHash("sha256")
    .update(await readFile(nativeCliPath))
    .digest("hex");
  const root = await mkdtemp(join(tmpdir(), "zcode-native-v4-certification-"));
  const workspace = join(root, "workspace");
  const dataBaseDir = join(root, "data");
  const home = join(root, "home");
  await Promise.all([
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(dataBaseDir, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(join(workspace, "input.txt"), "native fixture input\n", { mode: 0o600 });
  const markerPath = join(workspace, ".native-check-success");
  const checkNonce = randomUUID();
  const checkScript = createNativeCheckScript(workspace, markerPath, checkNonce);
  const checkScriptSha256 = createHash("sha256").update(checkScript).digest("hex");
  await writeFile(join(workspace, "check.mjs"), checkScript, { mode: 0o700 });
  await assert.rejects(stat(markerPath), { code: "ENOENT" });

  let gateway: Awaited<ReturnType<typeof startFakeGateway>> | undefined;
  let fixtureChild: FixtureChild | undefined;
  let spawnedPid: number | undefined;
  let client: ZCodeProtocolClient | undefined;
  let conversation: NativeV4ConversationState | undefined;
  let unsubscribeRequest: { dispose(): void } | undefined;
  let unsubscribeNotification: { dispose(): void } | undefined;
  let cleanupResult: ChildCleanupResult | undefined;
  let cleanupFailure: string | undefined;
  let childProcessClosed = false;
  let isolatedRootRemoved = false;
  let deniedPathAbsent = false;
  let stderr = "";
  let sessionId = "";
  let scenarioResults: NativeFakeScenarioResult[] = [];
  let resolutionAcks: unknown[] = [];
  let failureContext: unknown;
  let runFailure: string | undefined;
  let fetchAudit = await readNativeFetchAudit(join(root, "native-fetch-audit.jsonl"));

  try {
    await runNativeV4OfflineChecks(root);
    gateway = await startFakeGateway();
    const fixtureOrigin = `http://127.0.0.1:${gateway.port}`;
    const fetchGuard = await prepareNativeFetchGuard(root, 12, fixtureOrigin);
    const personalConfigPath = await writeNativeFakeProviderConfig(root, gateway.port);
    fixtureChild = spawnNativeFixtureChild(
      process.execPath,
      [nativeCliPath, "app-server", "--stdio"],
      {
        cwd: workspace,
        env: fakeNativeChildEnvironment({
          home,
          dataBaseDir,
          builtinConfigPath: nativeBuiltinProviderConfigPath,
          personalConfigPath,
          fetchGuardOptions: fetchGuard.nodeOptions,
          fetchAuditPath: fetchGuard.auditPath,
        }),
      },
    );
    const child = fixtureChild.process;
    spawnedPid = fixtureChild.pid;
    console.log(
      JSON.stringify({
        event: "native-v4-fake-child-spawned",
        nodeVersion: process.version,
        cliArtifactSha256,
        spawnPid: spawnedPid,
        detachedProcessGroup: false,
      }),
    );

    const transport = new ZCodeStdioTransport(child, {
      onStderrLine: (line) => {
        stderr = `${stderr}${line}\n`.slice(-8_000);
      },
    });
    const activeClient = new ZCodeProtocolClient(transport, { requestTimeoutMs: 45_000 });
    client = activeClient;
    unsubscribeRequest = activeClient.onRequest((request) => {
      if (request.method === "session/requestRuntimePreferences") {
        void activeClient.respond(request.id, {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: false,
          modelContextBudgetStrategy: "preflight-v1",
        });
      } else if (
        request.method === "interaction/requestPermission" ||
        request.method === "interaction/requestUserInput"
      ) {
        // V4 conversation snapshot owns approval state; rejecting this legacy request would race it.
        return;
      } else {
        void activeClient.respondError(request.id, {
          code: -32601,
          message: "native fixture request unsupported",
        });
      }
    });

    const createAck = await sendNativeCommand(activeClient, null, "createSession", {
      workspaceId: workspace,
      config: {
        mode: "build",
        modelSelection: {
          providerId: nativeFakeProviderId,
          modelId: nativeFakeModelId,
          options: { reasoningLevel: "off" },
        },
      },
    });
    sessionId = resultSessionId(createAck);
    const activeConversation = new NativeV4ConversationState(sessionId);
    conversation = activeConversation;
    unsubscribeNotification = activeClient.onNotification((notification) => {
      if (notification.method !== V4_NOTIFICATIONS.conversationFrame) return;
      try {
        activeConversation.acceptNotification(notification.params);
      } catch (error) {
        activeConversation.reportFailure(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const subscribeResult = await activeClient.request(
      V4_METHODS.conversationSubscribe,
      {
        topic: `conversation/${sessionId}`,
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

    if (gateway.state.requests.length !== 0)
      throw new Error("offline probes polluted the native fake scenario history");
    const dependencies = {
      client: activeClient,
      conversation: activeConversation,
      gateway: gateway.state,
      requests: gateway.state.requests,
      sessionId,
      workspace,
      mode: "build",
      providerId: nativeFakeProviderId,
      modelId: nativeFakeModelId,
      resolutionAcks,
    };

    const full = await runNativeFullScenario(dependencies);
    scenarioResults.push(full);
    assert.equal(await readFile(join(workspace, "output.txt"), "utf8"), nativeExpectedOutput);
    assert.equal(await readFile(markerPath, "utf8"), `${checkNonce}\n`);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(workspace, "check.mjs")))
        .digest("hex"),
      checkScriptSha256,
      "full fake turn changed the nonce-protected check script",
    );

    const followup = await runNativeFollowupScenario(dependencies);
    scenarioResults.push(followup);
    const deny = await runNativeDenyScenario(dependencies);
    scenarioResults.push(deny);
    await assert.rejects(readFile(join(workspace, "..", "native-denied-sentinel.txt")), {
      code: "ENOENT",
    });
    deniedPathAbsent = true;

    const stopped = await runNativeStopScenario(dependencies);
    scenarioResults.push(stopped);
    assert.ok(
      stopped.rows.some((row) => row.turnId === stopped.turnId && row.kind === "userInput"),
    );

    await gateway.state.waitForScenarioResponse("title-generation", full.fixtureTurnId);
    assert.equal(gateway.state.requests.length, 10);
    const mainScenarioRequests = gateway.state.requests.filter(
      (request) => request.scenario !== "title-generation",
    );
    assert.equal(mainScenarioRequests.length, 9);
    assert.ok(mainScenarioRequests.every((request) => requestHasFunctionTools(request)));
    assert.ok(
      mainScenarioRequests.every(
        (request) => request.body.max_tokens === nativeFakeOutputTokenLimit,
      ),
    );
    const stopRequests = gateway.state.requests.filter((request) => request.stage === "stop");
    assert.equal(stopRequests.length, 1);
    assertScenarioHistory(gateway.state.requests, "title-generation", full.fixtureTurnId, [
      "title",
    ]);
    assertScenarioHistory(gateway.state.requests, "full", full.fixtureTurnId, [
      "read",
      "read",
      "write",
      "bash",
      "text",
    ]);
    fetchAudit = await readNativeFetchAudit(fetchGuard.auditPath);
    const fetchAuditText = await readFile(fetchGuard.auditPath, "utf8");
    assert.ok(
      fetchAudit.logicalFetchAttempts >= gateway.state.requests.length,
      `fake Provider requests were not represented by the fetch guard: ${JSON.stringify(fetchAudit)}`,
    );
    assert.equal(fetchAudit.blockedBeforeSend, 0);
    assert.equal(fetchAudit.unknownOutcomes, 0);
    assert.equal(fetchAudit.routeAttempts.titleSidecar, 1);
    assert.equal(fetchAudit.routeAttempts.providerModel, gateway.state.requests.length - 1);
    assert.equal(fetchAudit.routeAttempts.auxiliary, 0);
    assert.equal(fetchAudit.routeAttempts.unknown, 0);
    assert.equal(fetchAuditText.includes("Generate a concise title"), false);
    assert.equal(fetchAuditText.includes("native live output"), false);
    assert.ok(fetchAudit.cancelledFetches > 0, "stop must cancel the held Provider fetch");
  } catch (error) {
    runFailure = safeFakeFailureClass(error);
    fetchAudit = await readNativeFetchAudit(join(root, "native-fetch-audit.jsonl")).catch(
      () => fetchAudit,
    );
    const snapshot = conversation?.snapshot;
    const currentHeader = conversation?.turnHeaders().at(-1);
    const currentRows = currentHeader
      ? (snapshot?.rows.window.filter((row) => row.turnId === currentHeader.turnId) ?? [])
      : [];
    const toolDiagnostics = currentRows
      .filter((row) => row.kind === "toolCall")
      .map((row) => diagnoseNativeLiveToolRow(row, workspace));
    const failureRecord = {
      files: await nativeFakeWorkspaceFiles(workspace),
      scenarioRequests: gateway ? summarizeFakeRequests(gateway.state.requests) : [],
      currentTurn: currentHeader
        ? {
            turnId: currentHeader.turnId,
            logEpoch: snapshot?.logEpoch,
            state: currentHeader.state,
          }
        : null,
      toolDiagnostics,
      pendingInteractions: conversation?.snapshot?.pendingInteractions.map((item) => ({
        interactionId: item.interactionId,
        kind: item.kind,
        toolCallId: item.payload.kind === "permission" ? item.payload.toolCallId : undefined,
      })),
      turnHeaders: conversation
        ?.turnHeaders()
        .map((item) => ({ turnId: item.turnId, state: item.state })),
      childStderr: { captured: stderr.length > 0, boundedBytes: stderr.length },
    };
    failureContext = failureRecord;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      process.stderr.write(
        `${JSON.stringify({ event: "native-v4-fake-failure-diagnostics", errorClass: runFailure, ...failureRecord })}\n`,
        (writeError) => (writeError ? rejectPromise(writeError) : resolvePromise()),
      );
    });
  } finally {
    unsubscribeNotification?.dispose();
    unsubscribeRequest?.dispose();
    gateway?.state.releaseActiveStopTurn();
    if (fixtureChild) {
      try {
        cleanupResult = await cleanupNativeFixtureChild(fixtureChild, client);
        childProcessClosed =
          fixtureChild.process.exitCode !== null || fixtureChild.process.signalCode !== null;
      } catch (error) {
        cleanupFailure = error instanceof Error ? error.message : String(error);
      }
    } else {
      childProcessClosed = true;
    }
    if (gateway) {
      gateway.server.closeAllConnections();
      if (gateway.server.listening) {
        try {
          await new Promise<void>((resolvePromise, rejectPromise) => {
            gateway!.server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
          });
        } catch (error) {
          cleanupFailure ??= error instanceof Error ? error.message : String(error);
        }
      }
    }
    await rm(root, { recursive: true, force: true }).catch((error: unknown) => {
      cleanupFailure ??= error instanceof Error ? error.message : String(error);
    });
    await stat(root).then(
      () => undefined,
      (error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          isolatedRootRemoved = true;
      },
    );
  }

  const cleanup = cleanupResult ?? {
    exitCode: fixtureChild?.process.exitCode ?? null,
    signal: fixtureChild?.process.signalCode ?? null,
    normal: fixtureChild === undefined,
    forcedTermination: null,
    ...(cleanupFailure ? { transportCleanupError: cleanupFailure } : {}),
  };
  const { status, report } = buildNativeFakeReport({
    actualNodeVersion: process.version,
    cliArtifactSha256,
    spawnPid: spawnedPid,
    cleanup,
    childProcessClosed,
    isolatedRootRemoved,
    cleanupFailed: cleanupFailure !== undefined,
    source: "fake-provider",
    scenarioResults,
    fakeGatewayRequests: gateway?.state.requests.length ?? 0,
    fetchAudit,
    resolutionCount: resolutionAcks.length,
    deniedPathAbsent,
    runFailure,
    failureContext,
  });
  console.log(JSON.stringify(report));
  if (status !== "native-v4-fake-pass")
    throw new Error(`native fake fixture failed: ${runFailure ?? "child cleanup was not normal"}`);
}

export async function runNativeV4Fake(): Promise<void> {
  await main();
}
