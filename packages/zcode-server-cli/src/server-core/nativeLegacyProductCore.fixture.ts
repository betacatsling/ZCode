import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
  IZCodeAgentService,
} from "@zcode/services";
import { createCoreAuthority } from "@zcode/services/node";
import { CHILD_MODEL, writeProviderConfig } from "./nativeLegacyProductCore.provider.js";
import { migrateOriginalLegacySession } from "./nativeLegacyProductCore.migration.js";
import {
  recordWorkerPid,
  sendText,
  subscribeConversation,
  waitForAnyTerminal,
  waitForTerminal,
  type WorkspaceScope,
} from "./nativeLegacyProductCore.protocol.js";

const TARGET_ID = "native-legacy-product";
const PROJECT_ID = "legacy-project";
const BINDING_ID = "legacy-binding";
const WORKSPACE_ID = "legacy-workspace";
const LEGACY_SESSION_ID = "native-legacy-core-original";
const ROOT = process.env.CORE_NATIVE_LEGACY_FIXTURE_ROOT!;
const CWD = process.env.CORE_NATIVE_LEGACY_FIXTURE_CWD!;
const DB_PATH = process.env.ZCODE_SESSION_DB_PATH!;
const CONFIG_ROOT = join(ROOT, ".zcode", "v2");

interface FixtureResult {
  kind: "result";
  unmappedOwner: null;
  indexedOriginalId: string;
  mappingCount: number;
  joinedOwner: { kind: string; originalSessionId: string; historyOnly: boolean };
  initialCommandStatus: string;
  followupCommandStatus: string;
  followupTerminal: boolean;
  runningCommandStatus: string;
  queuedCommandStatus: string;
  queuedRetryStatus: string;
  reconnectSubscription: boolean;
  sideSessionStatus: string;
  sideSessionId: string;
  sideSessionParentId: string;
  duplicateSideSessionStatus: string;
  modelCalls: string[];
  modelRequestContainsInput: boolean[];
  workerPids: number[];
  coldOwner: { originalSessionId: string; historyOnly: boolean };
  coldResumeIds: string[];
}

let authority: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
let server: Server | undefined;
let mappingCount = 0;
const modelCalls: string[] = [];
const modelRequests: string[] = [];
const ownedProcessPids = new Set<number>();
let notifyHeldRequest: (() => void) | undefined;
const heldRequest = new Promise<void>((resolve) => {
  notifyHeldRequest = resolve;
});
let releaseHeldResponse: (() => void) | undefined;
const heldResponse = new Promise<void>((resolve) => {
  releaseHeldResponse = resolve;
});

try {
  const modelUrl = await startFixtureModel();
  await writeProviderConfig(ROOT, modelUrl);
  process.env.ZCODE_AGENT_SERVER_ARGS_JSON = JSON.stringify([
    "--import",
    fileURLToPath(import.meta.resolve("tsx")),
    join(process.cwd(), "apps/zcode-cli/packages/cli/src/main.ts"),
    "app-server",
    "--stdio",
  ]);
  authority = await openCore();
  const catalog = authority.services.get(IProjectCatalogRpcService);
  const hierarchy = authority.services.get(IWorkspaceHierarchyService);
  const agent = authority.services.get(IZCodeAgentService);
  await catalog.importProject({
    id: PROJECT_ID,
    name: "Legacy product fixture",
    targetId: TARGET_ID,
    repositoryPath: CWD,
    bindingId: BINDING_ID,
  });
  await catalog.adopt({
    bindingId: BINDING_ID,
    workspaceId: WORKSPACE_ID,
    title: "Existing worktree",
    worktreePath: CWD,
  });
  const workspace = await catalog.workspace(WORKSPACE_ID);
  const binding = await catalog.binding(BINDING_ID);
  assert.ok(workspace && binding);
  assert.equal(workspace.workspaceIdentity, await realpath(CWD));
  assert.equal(binding.executionTargetId, TARGET_ID);
  const scope: WorkspaceScope = {
    targetId: TARGET_ID,
    workspacePath: workspace.worktreePath,
    workspaceIdentity: workspace.workspaceIdentity,
  };
  const unmappedOwner = await hierarchy.resolveOwner({
    targetId: TARGET_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: LEGACY_SESSION_ID,
  });
  assert.equal(unmappedOwner, undefined, "unmapped SQLite rows are not Core owner evidence");

  await agent.resumeSession({ ...scope, sessionId: LEGACY_SESSION_ID });
  await recordWorkerPid(agent, scope, ownedProcessPids);
  const initialCommand = "legacy-core-index-materialization";
  await subscribeConversation(agent, scope, LEGACY_SESSION_ID);
  const initialTerminal = waitForTerminal(agent, scope, LEGACY_SESSION_ID, initialCommand);
  const initialAck = await sendText(
    agent,
    scope,
    LEGACY_SESSION_ID,
    initialCommand,
    "legacy core index seed",
  );
  assert.equal(initialAck.status, "accepted");
  await initialTerminal;

  const migrated = await migrateOriginalLegacySession({
    services: authority.services,
    configRoot: CONFIG_ROOT,
    dbPath: DB_PATH,
    targetId: TARGET_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: LEGACY_SESSION_ID,
    workspace,
    binding,
  });
  mappingCount = migrated.mappingCount;
  await authority.dispose();
  authority = undefined;

  authority = await openCore();
  const joinedHierarchy = authority.services.get(IWorkspaceHierarchyService);
  const joinedOwner = await joinedHierarchy.resolveOwner({
    targetId: TARGET_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: LEGACY_SESSION_ID,
  });
  assert.ok(joinedOwner && joinedOwner.kind === "native");
  assert.equal(joinedOwner.originalSessionId, LEGACY_SESSION_ID);
  assert.equal(joinedOwner.historyOnly, false);
  const joinedAgent = authority.services.get(IZCodeAgentService);
  await joinedAgent.resumeSession({ ...scope, sessionId: joinedOwner.originalSessionId });
  await recordWorkerPid(joinedAgent, scope, ownedProcessPids);
  const joinedSubscription = await subscribeConversation(
    joinedAgent,
    scope,
    joinedOwner.originalSessionId,
  );
  const followupCommand = "legacy-core-followup";
  const followupTerminal = waitForTerminal(
    joinedAgent,
    scope,
    joinedOwner.originalSessionId,
    followupCommand,
  );
  const followupAck = await sendText(
    joinedAgent,
    scope,
    joinedOwner.originalSessionId,
    followupCommand,
    "legacy core followup",
  );
  assert.equal(followupAck.status, "accepted");
  await followupTerminal;

  // The Model request stays in flight while CLI CommandInbox admits the next input.
  // Detaching a view cannot become a second writer or resend the accepted queue entry.
  const runningCommand = "legacy-core-held-running";
  const queuedCommand = "legacy-core-busy-queued";
  const runningTerminal = waitForTerminal(joinedAgent, scope, LEGACY_SESSION_ID, runningCommand);
  const runningAck = await sendText(
    joinedAgent,
    scope,
    LEGACY_SESSION_ID,
    runningCommand,
    "held parent input",
  );
  assert.equal(runningAck.status, "accepted");
  await heldRequest;
  const queuedTerminal = waitForTerminal(joinedAgent, scope, LEGACY_SESSION_ID, queuedCommand);
  const queuedAck = await joinedAgent.sendConversationCommandV4({
    ...scope,
    envelope: {
      commandId: queuedCommand,
      clientId: "native-legacy-core-client",
      sessionId: LEGACY_SESSION_ID,
      type: "sendText",
      issuedAt: Date.now(),
      payload: { text: "queued parent input", requestedDelivery: "queue" },
    },
  });
  assert.equal(queuedAck.status, "accepted");
  assert.equal(
    modelCalls.length,
    3,
    "queued input cannot launch a second Model while first is held",
  );
  await joinedAgent.unsubscribeConversationV4({ ...scope, subscriptionId: joinedSubscription });
  const reconnectSubscription = await subscribeConversation(joinedAgent, scope, LEGACY_SESSION_ID);
  const queuedRetry = await joinedAgent.sendConversationCommandV4({
    ...scope,
    envelope: {
      commandId: queuedCommand,
      clientId: "native-legacy-core-client",
      sessionId: LEGACY_SESSION_ID,
      type: "sendText",
      issuedAt: Date.now(),
      payload: { text: "queued parent input", requestedDelivery: "queue" },
    },
  });
  assert.equal(queuedRetry.status, "duplicate");
  releaseHeldResponse?.();
  await runningTerminal;
  await queuedTerminal;
  assert.equal(modelCalls.length, 4);

  const sideCommand = "legacy-core-side-session";
  const sideEnvelope = {
    commandId: sideCommand,
    clientId: "native-legacy-core-client",
    sessionId: LEGACY_SESSION_ID,
    type: "createSelectionSideSession" as const,
    issuedAt: Date.now(),
    payload: {
      firstInput: { text: "selection side child input", modelSelection: CHILD_MODEL },
    },
  };
  const sideTerminalWait = waitForAnyTerminal(joinedAgent, scope, sideCommand);
  const sideAck = await joinedAgent.sendConversationCommandV4({ ...scope, envelope: sideEnvelope });
  assert.equal(sideAck.status, "accepted");
  const sideSessionId =
    sideAck.result?.type === "createSelectionSideSession" ? sideAck.result.sessionId : undefined;
  assert.ok(sideSessionId && sideSessionId !== LEGACY_SESSION_ID);
  const sideSubscription = await subscribeConversation(joinedAgent, scope, sideSessionId);
  await sideTerminalWait;
  const duplicateSideAck = await joinedAgent.sendConversationCommandV4({
    ...scope,
    envelope: sideEnvelope,
  });
  assert.equal(duplicateSideAck.status, "duplicate");
  assert.equal(modelCalls.length, 5, "duplicate command must not issue another Model request");
  await joinedAgent.unsubscribeConversationV4({ ...scope, subscriptionId: sideSubscription });
  await joinedAgent.unsubscribeConversationV4({ ...scope, subscriptionId: reconnectSubscription });

  await authority.dispose();
  authority = undefined;
  authority = await openCore();
  const coldOwner = await authority.services.get(IWorkspaceHierarchyService).resolveOwner({
    targetId: TARGET_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: LEGACY_SESSION_ID,
  });
  assert.ok(coldOwner && coldOwner.kind === "native");
  const coldAgent = authority.services.get(IZCodeAgentService);
  const parentSnapshot = await coldAgent.resumeSession({ ...scope, sessionId: LEGACY_SESSION_ID });
  await recordWorkerPid(coldAgent, scope, ownedProcessPids);
  const sideSnapshot = await coldAgent.resumeSession({ ...scope, sessionId: sideSessionId });
  assert.deepEqual(modelCalls, [
    "fixture-model",
    "fixture-model",
    "fixture-model",
    "fixture-model",
    "fixture-other",
  ]);
  const expectedInputs = [
    "legacy core index seed",
    "legacy core followup",
    "held parent input",
    "queued parent input",
    "selection side child input",
  ];
  const modelRequestContainsInput = expectedInputs.map(
    (input, index) => modelRequests[index]?.includes(input) ?? false,
  );
  assert.deepEqual(modelRequestContainsInput, [true, true, true, true, true]);
  const result: FixtureResult = {
    kind: "result",
    unmappedOwner: null,
    indexedOriginalId: migrated.indexedOriginalId,
    mappingCount,
    joinedOwner: {
      kind: joinedOwner.kind,
      originalSessionId: joinedOwner.originalSessionId,
      historyOnly: joinedOwner.historyOnly,
    },
    initialCommandStatus: initialAck.status,
    followupCommandStatus: followupAck.status,
    followupTerminal: true,
    runningCommandStatus: runningAck.status,
    queuedCommandStatus: queuedAck.status,
    queuedRetryStatus: queuedRetry.status,
    reconnectSubscription: reconnectSubscription !== joinedSubscription,
    sideSessionStatus: sideAck.status,
    sideSessionId,
    sideSessionParentId: LEGACY_SESSION_ID,
    duplicateSideSessionStatus: duplicateSideAck.status,
    modelCalls: [...modelCalls],
    modelRequestContainsInput,
    workerPids: [...ownedProcessPids],
    coldOwner: {
      originalSessionId: coldOwner.originalSessionId,
      historyOnly: coldOwner.historyOnly,
    },
    coldResumeIds: [parentSnapshot.session.sessionId, sideSnapshot.session.sessionId],
  };
  process.send?.(result);
} catch (error) {
  process.send?.({
    kind: "error",
    message: error instanceof Error ? error.message : "fixture-failed",
  });
  process.exitCode = 1;
} finally {
  await authority?.dispose().catch(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (process.connected) process.disconnect?.();
}

async function openCore() {
  const core = await createCoreAuthority({
    installationId: TARGET_ID,
    profileRoot: ROOT,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
  });
  await core.reconcileBeforeAdmission();
  return core;
}

async function startFixtureModel(): Promise<string> {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let model = "unknown";
    try {
      const body = Buffer.concat(chunks).toString();
      modelRequests.push(body);
      model = String((JSON.parse(body) as { model?: unknown }).model);
    } catch {
      response.writeHead(400).end();
      return;
    }
    modelCalls.push(model);
    const event = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (modelCalls.length === 3) {
      notifyHeldRequest?.();
      await heldResponse;
    }
    response.end(
      event("message_start", {
        message: {
          id: `legacy-core-${modelCalls.length}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }) +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "native legacy core fixture response" },
        }) +
        event("content_block_stop", { index: 0 }) +
        event("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 4 },
        }) +
        event("message_stop", {}),
    );
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/fixture`;
}
