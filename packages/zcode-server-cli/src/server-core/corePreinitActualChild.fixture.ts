/* Actual Core/CLI/Host joined lifecycle fixture; all data and children are disposable. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCoreAuthority } from "@zcode/services/node";
import {
  createZCodeAgentConnectionScope,
  IAgentHostService,
  IProjectCatalogRpcService,
  IZCodeAgentService,
} from "@zcode/services";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import type { ProjectCatalogRpcService } from "@zcode/services";
import { countNativeSessions, waitForEarlyAck } from "./corePreinitActualSupport.fixture.js";
import { runServerCore } from "./core.js";
import type { CoreAuthorityFactory } from "./authority.js";
import { resolveCoreServerId } from "./serverIdentity.js";

const git = promisify(execFile);
const root = process.env.ZCODE_DATA_BASE_DIR!;
const profileRoot = process.env.ZCODE_SERVER_ROOT!;
const providerConfig = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!;
const earlyAckFile = process.env.CORE_PREINIT_EARLY_ACK_FILE!;
const selection = {
  providerId: "fixture",
  modelId: "fixture-model",
  options: { reasoningLevel: "off" },
};
const seedCreateCommandId = "core-preinit-seed-create";
const seedInputCommandId = "core-preinit-seed-input";
const repo = join(root, "repository");
const resolvedTargetId = await resolveCoreServerId();
if (!resolvedTargetId) throw new Error("isolated Core installation identity unavailable");
const targetId: string = resolvedTargetId;

type Owner = Awaited<ReturnType<typeof createCoreAuthority>>;
type Workspace = Awaited<ReturnType<ProjectCatalogRpcService["adopt"]>>;
let seedOwner: Owner | undefined;
let owner: Owner | undefined;
let workspace: Workspace | undefined;
let seedSession: string | undefined;
let finishSeed!: () => void;
let publishReady!: () => void;
let publishReadyRequested = false;
let cleanupStarted = false;
const seedGate = new Promise<void>((resolve) => (finishSeed = resolve));
const readyGate = new Promise<void>((resolve) => (publishReady = resolve));

const send = (message: unknown): void => {
  if (typeof process.send === "function" && process.connected !== false) process.send(message);
};
function waitForSeedFinish(): Promise<void> {
  return seedGate;
}
function createHostSpec(): SessionSpecV2 {
  if (!workspace?.workspaceIdentity) throw new Error("persisted workspace identity unavailable");
  return {
    schemaVersion: 2,
    hostSessionId: "boot-host",
    projectId: "project",
    workspaceId: "workspace",
    execution: {
      targetId,
      workspaceIdentity: workspace.workspaceIdentity,
      worktreePath: workspace.worktreePath,
      worktreeGeneration: workspace.worktreeGeneration,
      cwdRelativeToWorktree: ".",
    },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding: { kind: "host-managed", selection },
  };
}
function sendTextEnvelope(commandId: string, sessionId: string, text: string) {
  return {
    commandId,
    clientId: "core-preinit-fixture",
    sessionId,
    type: "sendText" as const,
    issuedAt: Date.now(),
    payload: { text },
  };
}

async function waitForSeedTurnTerminal(
  native: IZCodeAgentService,
  sessionId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let subscription: { dispose(): void } | undefined;
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.dispose();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => settle(new Error("public seed turn terminal deadline")), 20_000);
    subscription = native.onDynamicSessionEvent({
      workspacePath: process.cwd(),
      sessionId,
      deliveryKind: "desktop-continuous",
      afterSeq: 0,
    })((event) => {
      if (event.type !== "session.event") return;
      if (event.event.type === "turn.completed") settle();
      else if (event.event.type === "turn.failed") {
        settle(new Error(`public seed turn failed: ${JSON.stringify(event.event.payload)}`));
      }
    });
  });
}

async function seedPublicHistory(): Promise<void> {
  await mkdir(repo);
  await git("git", ["init", "-q", repo]);
  await writeFile(join(repo, "README"), "isolated\n");
  await git("git", ["-C", repo, "add", "README"]);
  await git("git", [
    "-C",
    repo,
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "user.name=fixture",
    "commit",
    "-qm",
    "initial",
  ]);
  seedOwner = await createCoreAuthority({
    installationId: targetId,
    profileRoot,
    zcodeBuiltinProviderConfigFilePath: providerConfig,
  });
  await seedOwner.reconcileBeforeAdmission();
  const catalog = seedOwner.services.get(IProjectCatalogRpcService);
  await catalog.importProject({
    id: "project",
    name: "Fixture",
    targetId,
    repositoryPath: repo,
    bindingId: "binding",
  });
  workspace = await catalog.adopt({
    bindingId: "binding",
    workspaceId: "workspace",
    title: "Main",
    worktreePath: repo,
  });
  // 先完成实际 Provider Registry 的只读配置初始化；它不是 Model/tool 执行。
  await seedOwner.services.get(IAgentHostService).catalogForTarget(targetId);

  // 只经真实 CLI V4 公共命令创建 session，再单独提交普通 sendText；不伪造 SQLite 行或 pending create。
  const native = seedOwner.services.get(IZCodeAgentService);
  const created = await native.sendConversationCommandV4({
    workspacePath: process.cwd(),
    envelope: {
      commandId: seedCreateCommandId,
      clientId: "core-preinit-seed",
      sessionId: null,
      type: "createSession",
      issuedAt: Date.now(),
      payload: {
        workspaceId: process.cwd(),
        config: { modelSelection: selection, mode: "build" },
      },
    },
  });
  if (created.status !== "accepted" || created.result?.type !== "createSession")
    throw new Error(`public seed create was not accepted: ${JSON.stringify(created)}`);
  seedSession = created.result.sessionId;
  const accepted = await native.sendConversationCommandV4({
    workspacePath: process.cwd(),
    envelope: sendTextEnvelope(
      seedInputCommandId,
      seedSession,
      "ordinary input before cold reopen",
    ),
  });
  if (accepted.status !== "accepted")
    throw new Error(`public ordinary input was not accepted: ${JSON.stringify(accepted)}`);
  await waitForSeedTurnTerminal(native, seedSession);
  send({
    type: "seeded",
    seedTurnTerminal: true,
    targetId,
    workspaceIdentity: workspace.workspaceIdentity,
    worktreePath: workspace.worktreePath,
    worktreeGeneration: workspace.worktreeGeneration,
    sessionId: seedSession,
    createStatus: created.status,
    inputStatus: accepted.status,
    persistedNativeSessions: countNativeSessions(),
  });
  await waitForSeedFinish();
  await seedOwner.dispose();
  seedOwner = undefined;
  send({ type: "seed-closed", persistedNativeSessions: countNativeSessions() });
}

async function runCoreWithHeldAuthority(): Promise<void> {
  if (!seedSession) throw new Error("prior accepted CLI session unavailable");
  process.env.CORE_PREINIT_EARLY_SESSION_ID = seedSession;
  const factory: CoreAuthorityFactory = async (options) => {
    send({ type: "stage", name: "factory-entered" });
    owner = await createCoreAuthority({ ...options, admissionFence: "held" });
    send({ type: "stage", name: "factory-created" });
    const actual = owner;
    return {
      services: actual.services,
      maintenance: actual.maintenance,
      async reconcileBeforeAdmission() {
        // 真正的 Catalog reconciliation 完成，但原 boot Inbox/Target lease 仍保持关闭。
        await actual.reconcileBeforeAdmission();
        send({ type: "stage", name: "reconciled" });
        const earlyAck = await waitForEarlyAck(earlyAckFile, 20_000);
        send({ type: "stage", name: "early-ack" });
        const host = actual.services.get(IAgentHostService);
        await host.catalogForTarget(targetId);
        send({ type: "stage", name: "catalog" });
        send({
          type: "authority-reconciled",
          corePublication: "not-yet-ready",
          admissionEnabled: (await host.getAvailability()).admissionEnabled,
          earlyAck,
          coldCommand: await readSeedInputOnSameCli(actual),
          persistedNativeSessions: countNativeSessions(),
        });
        if (!publishReadyRequested) await readyGate;
      },
      async dispose() {
        await actual.dispose();
        let disposedLeaseRejected = false;
        try {
          await actual.bootAdmissionLease?.release();
        } catch {
          disposedLeaseRejected = true;
        }
        send({ type: "disposed-release", rejected: disposedLeaseRejected });
      },
    };
  };
  await runServerCore(1, factory);
}

async function readSeedInputOnSameCli(actual: Owner): Promise<unknown> {
  if (!seedSession) throw new Error("prior public session missing");
  const scoped = createZCodeAgentConnectionScope(actual.services.get(IZCodeAgentService), {
    connectionId: "core-preinit-read-only-reopen",
    clientMode: "desktop-continuous",
    role: "trusted-host-relay",
  });
  try {
    const result = await scoped.service.queryConversationCommandsV4({
      workspacePath: process.cwd(),
      commands: [{ sessionId: seedSession, commandId: seedInputCommandId }],
    });
    send({ type: "stage", name: "cold-query-received" });
    return result;
  } finally {
    await scoped.dispose();
    send({ type: "stage", name: "cold-query-disposed" });
  }
}

async function probeWhileHeld(): Promise<void> {
  if (!owner || !seedSession) throw new Error("held Core owner not ready for probe");
  const host = owner.services.get(IAgentHostService);
  const availability = await host.getAvailability();
  let hostRefused = false;
  let hostError = "";
  try {
    await host.create(createHostSpec(), "held-external-command");
  } catch (error) {
    hostError = String(error);
    hostRefused = /disabled|frozen|held/i.test(hostError);
  }
  const beforeCount = countNativeSessions();
  const native = owner.services.get(IZCodeAgentService);
  let nativeResult: { status?: string; reasonCode?: string; error?: string };
  try {
    const ack = await native.sendConversationCommandV4({
      workspacePath: process.cwd(),
      envelope: sendTextEnvelope(
        "core-preinit-held-native-send",
        seedSession,
        "this actual V4 input must stay held",
      ),
    });
    nativeResult = { status: ack.status, reasonCode: ack.reasonCode };
  } catch (error) {
    nativeResult = { error: String(error) };
  }
  send({
    type: "held-probe",
    availabilityEnabled: availability.admissionEnabled,
    hostRefused,
    hostError,
    nativeResult,
    nativeSessionsBefore: beforeCount,
    nativeSessionsAfter: countNativeSessions(),
  });
}

async function releaseAndRunSameOwner(): Promise<void> {
  const actual = owner;
  const lease = actual?.bootAdmissionLease;
  if (!actual || !lease || !seedSession) throw new Error("same held boot owner missing");
  send({ type: "stage", name: "release-started" });
  await lease.release(); // awaits the exact selected CLI worker release ACK
  send({ type: "stage", name: "release-ack" });
  const host = actual.services.get(IAgentHostService);
  const spec = createHostSpec();
  const created = await host.create(spec, "after-release-create");
  send({ type: "stage", name: "host-created" });
  const terminal = new Promise<string[]>((resolve, reject) => {
    let disposeSubscription = (): void => undefined;
    const timer = setTimeout(() => {
      disposeSubscription();
      void Promise.all([host.eventsSince(spec, 0), host.snapshot(spec)]).then(
        ([events, snapshot]) =>
          reject(
            new Error(`terminal Host event deadline: ${JSON.stringify({ events, snapshot })}`),
          ),
        reject,
      );
    }, 20_000);
    const subscription = host.onEvent(({ spec: eventSpec, event }) => {
      if (eventSpec.hostSessionId !== spec.hostSessionId) return;
      if (event.kind !== "turn.finished") return;
      clearTimeout(timer);
      disposeSubscription();
      void host.eventsSince(spec, 0).then((events) => {
        if (event.outcome !== "success")
          reject(new Error(`Host turn ${event.outcome}: ${JSON.stringify(events)}`));
        else resolve(events.map((item) => item.kind));
      }, reject);
    });
    disposeSubscription = () => subscription.dispose();
  });
  const ack = await host.dispatch(spec, {
    type: "send",
    commandId: "after-release-send",
    hostSessionId: spec.hostSessionId,
    turnId: "boot-turn",
    text: "Answer briefly without tools",
  });
  send({ type: "stage", name: "host-dispatch", status: ack.status });
  if (ack.status !== "accepted")
    throw new Error(`post-release Host command rejected: ${ack.status}`);
  const eventKinds = await terminal;
  send({
    type: "joined",
    releaseAck: true,
    created: created.sessionId,
    receipt: (await host.queryCommand(spec, "after-release-send"))?.status,
    eventKinds,
    workspaceId: workspace?.id,
    nativeSessions: countNativeSessions(),
  });
}

async function disposeOnDisconnect(): Promise<void> {
  if (cleanupStarted) return;
  cleanupStarted = true;
  finishSeed();
  publishReadyRequested = true;
  publishReady();
  try {
    await seedOwner?.dispose();
    await owner?.dispose();
  } catch {
    // Test process teardown remains finite; the parent separately verifies recorded children.
  }
}

process.on("message", (message: unknown) => {
  if (message === "finish-seed") finishSeed();
  else if (message === "start-core")
    void runCoreWithHeldAuthority().catch((error: unknown) => {
      send({ type: "failure", error: String(error instanceof Error ? error.stack : error) });
      process.exitCode = 1;
    });
  else if (message === "probe-held")
    void probeWhileHeld().catch((error: unknown) =>
      send({ type: "failure", error: String(error instanceof Error ? error.stack : error) }),
    );
  else if (message === "publish-ready") {
    publishReadyRequested = true;
    publishReady();
  } else if (message === "release")
    void releaseAndRunSameOwner().catch((error: unknown) =>
      send({ type: "failure", error: String(error instanceof Error ? error.stack : error) }),
    );
});
process.on("disconnect", () => void disposeOnDisconnect());

try {
  await seedPublicHistory();
} catch (error) {
  send({ type: "failure", error: String(error instanceof Error ? error.stack : error) });
  process.exitCode = 1;
}
