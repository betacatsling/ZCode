import assert from "node:assert/strict";
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
import {
  readLegacyVisibleInputs,
  verifyLegacyActions,
  type LegacyFixtureResult,
} from "./nativeLegacyProductCore.actions.js";
import { migrateOriginalLegacySession } from "./nativeLegacyProductCore.migration.js";
import { startFixtureModel, type FixtureModel } from "./nativeLegacyProductCore.model.js";
import {
  verifyHeldStopAndReplayable,
  verifyPermissionOperations,
} from "./nativeLegacyProductCore.operations.js";
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

let authority: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
let model: FixtureModel | undefined;
let mappingCount = 0;
const ownedProcessPids = new Set<number>();

try {
  model = await startFixtureModel(CWD);
  const modelCalls = model.calls;
  const modelRequests = model.requests;
  const modelUrl = model.url;
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
  await model.heldQueue.arrived;
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
  model.heldQueue.release();
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
  const forkProof = await verifyLegacyActions(joinedAgent, scope, LEGACY_SESSION_ID);
  const operations = await verifyPermissionOperations(
    joinedAgent,
    scope,
    LEGACY_SESSION_ID,
    CWD,
    modelRequests,
    modelCalls,
  );
  const stopAndReplayable = await verifyHeldStopAndReplayable(
    joinedAgent,
    scope,
    LEGACY_SESSION_ID,
    model.heldStop.arrived,
    () => model!.heldStop.release(),
    modelCalls,
  );

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
  const forkSnapshot = await coldAgent.resumeSession({ ...scope, sessionId: forkProof.forkedId });
  await recordWorkerPid(coldAgent, scope, ownedProcessPids);
  const coldVisibleInputs = await readLegacyVisibleInputs(coldAgent, scope, LEGACY_SESSION_ID);
  assert.equal(
    operations.callsAfterOperations,
    11,
    "two Write decisions and two real tool-result continuations",
  );
  assert.equal(modelCalls.length, 12, "held stop adds exactly one in-flight Model request");
  const expectedInputs = [
    "legacy core index seed",
    "legacy core followup",
    "held parent input",
    "queued parent input",
    "selection side child input",
    forkProof.editedText,
    forkProof.editedText,
  ];
  const modelRequestContainsInput = expectedInputs.map(
    (input, index) => modelRequests[index]?.includes(input) ?? false,
  );
  assert.deepEqual(modelRequestContainsInput, [true, true, true, true, true, true, true]);
  // rewind 语义不能只断言「新文本在场」：被截断的 queued intent 必须不再出现在
  // edit/retry 之后的请求里，且更早的已提交轮（held parent input）必须仍在上下文中。
  const rewoundInputsAbsent = [5, 6].every(
    (index) => !(modelRequests[index] ?? "").includes("queued parent input"),
  );
  const editContextPreserved = [5, 6].every((index) =>
    (modelRequests[index] ?? "").includes("held parent input"),
  );
  assert.ok(rewoundInputsAbsent, "rewound queued intent must not appear in post-edit requests");
  assert.ok(editContextPreserved, "edit must preserve earlier committed turn context");
  const heldStopRequestRecorded = (modelRequests[11] ?? "").includes("legacy stop held input");
  assert.ok(heldStopRequestRecorded, "held stop turn must reach the provider before cancellation");
  const result: LegacyFixtureResult = {
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
    ...forkProof,
    permissionDenial: operations.permissionDenial,
    permissionApproval: operations.permissionApproval,
    heldStop: stopAndReplayable.heldStop,
    replayable: stopAndReplayable.replayable,
    rewoundInputsAbsent,
    editContextPreserved,
    heldStopRequestRecorded,
    forkColdId: forkSnapshot.session.sessionId,
    coldVisibleInputs,
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
  const message = error instanceof Error ? error.message : "fixture-failed";
  // IPC message 可能在 disconnect 前丢失；同步写 stderr 保证父进程能看到真实失败原因。
  process.stderr.write(`fixture-error: ${message}\n`);
  process.send?.({ kind: "error", message });
  process.exitCode = 1;
} finally {
  await authority?.dispose().catch(() => {});
  await model?.close().catch(() => {});
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
