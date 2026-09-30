import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ExecutionTarget } from "@zcode/shared/agent-host";
import type { AgentHostConversationFrame } from "@zcode/shared/agent-host";
import {
  harnessDirectorySnapshotSchema,
  workspaceSessionBindingCapabilityResultSchema,
  type SessionSpec,
  type WorkspaceSessionBindingCapabilityRequest,
  type WorkspaceSessionBindingCapabilityResult,
} from "@zcode/shared/agent-host";
import { TargetModelGateway } from "@zcode/services/model-gateway";
import type { IWorktreeService } from "../projectWorkspaceServices.js";
import { HarnessRegistry, type HarnessAdapter } from "./harnessRegistry.js";
import { createAgentHostConversationBridge } from "./conversationBridge.js";
import { createRegistryModelCatalog } from "./registryCatalog.js";
import {
  ProviderCredentialAttention,
  readRegistryCredentialAttention,
} from "./providerCredentialAttention.js";
import { createRpcAgentHostService } from "./rpcTargetService.js";
import type { IAgentHostService } from "./serviceContract.js";
import { readHarnessStaticAsset } from "./harnessAssets.js";
import { authorizeLazyWorktreeAdmission } from "./lazyAuthorizeWorktree.js";
import {
  AgentHostTargetService,
  type TargetHostEvent,
  type WorkspaceAdmissionRunner,
  type NativeWorkspaceSessionOwnerPort,
  type WorkspaceAdmissionFenceChecker,
} from "./targetService.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("agent-host-lazy-target");

/** Lazy registration avoids loading Pi/Codex/Claude/Devin CLI adapters during native-only startup. */
export function createLazyTargetAgentHostService(input: {
  root: string;
  target: ExecutionTarget;
  registry: ProviderRegistryService;
  allowNewSessions: () => boolean;
  worktrees?: IWorktreeService;
  withWorkspaceAdmission?: WorkspaceAdmissionRunner;
  nativeOwner?: NativeWorkspaceSessionOwnerPort;
  checkAdmissionFence?: WorkspaceAdmissionFenceChecker;
  // 继续透传 owner generation，避免懒加载 Host 丢掉已有 owner fence。
  ownerGeneration?: number;
  /** 只读观察已注册 harness，不改变准入，也不另建 Gateway。 */
  observeRegisteredHarness?: (harness: HarnessAdapter) => void;
  /** Host-level credential attention; defaults to one owned by this lazy Host. */
  credentialAttention?: ProviderCredentialAttention;
}): {
  service: IAgentHostService;
  /**
   * 这个目标 Core 上的唯一共享 Gateway。
   * 注入 Codex 与 Claude（二者都不拥有它）。dispose 是唯一关闭者。
   * SSH 隧道断开不会调用它。
   */
  targetModelGateway: TargetModelGateway;
  dispose(): Promise<void>;
} {
  let target: AgentHostTargetService | undefined;
  let flight: Promise<AgentHostTargetService> | undefined;
  // 一份 owner 覆盖整个目标服务，包括尚未 warm 的阶段。
  // Codex 与 Claude 共用它；Pi / Devin 不经过 Gateway。
  const targetModelGateway = new TargetModelGateway();
  let targetDispose: (() => void) | undefined;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  const events = new Emitter<TargetHostEvent>();
  const conversationFrames = new Emitter<AgentHostConversationFrame>();
  const credentialAttention = input.credentialAttention ?? new ProviderCredentialAttention();
  // Cold capability reads report the Host-level mark without warming the target.
  const withCredentialAttention = (
    request: WorkspaceSessionBindingCapabilityRequest,
    result: WorkspaceSessionBindingCapabilityResult,
  ): WorkspaceSessionBindingCapabilityResult => {
    if (request.modelBinding.kind === "harness-managed") return result;
    const failure = readRegistryCredentialAttention(
      input.registry,
      credentialAttention,
      request.modelBinding.selection,
    )?.failure;
    return failure
      ? workspaceSessionBindingCapabilityResultSchema.parse({
          ...result,
          credentialAttention: failure,
        })
      : result;
  };
  const authorizeWorktree = async (spec: SessionSpec, realPath: string) =>
    authorizeLazyWorktreeAdmission({
      worktrees: input.worktrees,
      targetId: input.target.id,
      spec,
      realPath,
    });
  const historyOnly = new AgentHostTargetService({
    root: join(input.root, "sessions"),
    target: input.target,
    catalog: {
      fingerprint: "history-only",
      validateSelection: () => ({ ok: false as const, reason: "history-only" }),
    },
    registry: new HarnessRegistry(),
    authorizeWorktree,
    ...(input.worktrees ? { worktrees: input.worktrees } : {}),
    ...(input.nativeOwner ? { nativeOwner: input.nativeOwner } : {}),
    ...(input.checkAdmissionFence ? { checkAdmissionFence: input.checkAdmissionFence } : {}),
    ...(input.ownerGeneration ? { ownerGeneration: input.ownerGeneration } : {}),
  });
  const getTarget = async (): Promise<AgentHostTargetService> => {
    if (disposed) throw new Error("agent host service disposed");
    if (target) return target;
    if (!flight)
      flight = (async () => {
        await input.registry.start();
        const { createRegistryPiHarness } = await import("../agent-adapters/pi/createPiHarness.js");
        const { createExperimentalRegistryCodexHarness } =
          await import("../agent-adapters/codex/createCodexHarness.js");
        const { createExperimentalRegistryClaudeHarness } =
          await import("../agent-adapters/claude/createClaudeHarness.js");
        const { createExperimentalRegistryDevinHarness } =
          await import("../agent-adapters/devin/createDevinHarness.js");
        const modelAdapter = new AiSdkModelAdapter({});
        const harnesses = new HarnessRegistry();
        const workerRoot = join(input.root, "workers");
        const register = (harness: HarnessAdapter) => {
          harnesses.register(harness);
          input.observeRegisteredHarness?.(harness);
        };
        register(
          createRegistryPiHarness({
            root: workerRoot,
            registry: input.registry,
            adapter: modelAdapter,
          }),
        );
        register(
          createExperimentalRegistryCodexHarness({
            root: workerRoot,
            registry: input.registry,
            adapter: modelAdapter,
            targetModelGateway,
          }),
        );
        register(
          createExperimentalRegistryClaudeHarness({
            root: workerRoot,
            registry: input.registry,
            adapter: modelAdapter,
            targetModelGateway,
          }),
        );
        register(
          createExperimentalRegistryDevinHarness({
            root: workerRoot,
          }),
        );
        const instance = new AgentHostTargetService({
          root: join(input.root, "sessions"),
          target: input.target,
          catalog: createRegistryModelCatalog(input.registry, modelAdapter, credentialAttention),
          registry: harnesses,
          // Trusted target channel only; reject symlink aliases in this environment.
          authorizeWorktree,
          ...(input.worktrees ? { worktrees: input.worktrees } : {}),
          ...(input.withWorkspaceAdmission
            ? { withWorkspaceAdmission: input.withWorkspaceAdmission }
            : {}),
          ...(input.nativeOwner ? { nativeOwner: input.nativeOwner } : {}),
          ...(input.checkAdmissionFence ? { checkAdmissionFence: input.checkAdmissionFence } : {}),
          ...(input.ownerGeneration ? { ownerGeneration: input.ownerGeneration } : {}),
        });
        const rpc = createRpcAgentHostService(instance, input.allowNewSessions);
        const unsubscribe = rpc.service.onEvent((event) => events.fire(event));
        targetDispose = () => {
          unsubscribe.dispose();
          rpc.dispose();
        };
        target = instance;
        return instance;
      })().catch((error: unknown) => {
        flight = undefined;
        throw error;
      });
    return flight;
  };
  // One bridge owns subscription IDs across cold history and live attach. Its
  // source switches snapshot/rows/create/attach through the lazy target, while
  // the shared event emitter keeps an existing subscription on the same owner.
  const conversation = createAgentHostConversationBridge({
    create: (spec) => getTarget().then((service) => service.create(spec)),
    attach: (spec) => getTarget().then((service) => service.attach(spec)),
    snapshot: (spec) => (target ?? historyOnly).snapshot(spec),
    conversationRowsRange: (spec, request) =>
      (target ?? historyOnly).conversationRowsRange(spec, request),
    subscribe: (listener) => {
      const subscription = events.event(listener);
      return () => subscription.dispose();
    },
  });
  const conversationFrameSubscription = conversation.onFrame((frame) =>
    conversationFrames.fire(frame),
  );
  const service: IAgentHostService = {
    onEvent: events.event,
    onConversationFrame: conversationFrames.event,
    getAvailability: async () => ({
      target: input.target,
      harnesses: [
        ...(input.nativeOwner ? ["zcode"] : []),
        ...(input.allowNewSessions() ? ["pi", "codex", "claude-code", "devin"] : []),
      ],
      admissionEnabled:
        input.target.available && (Boolean(input.nativeOwner) || input.allowNewSessions()),
    }),
    async listSessions(workspaceIdentity, worktreePath) {
      return (target ?? historyOnly).listSessions(workspaceIdentity, worktreePath);
    },
    async getDirectory() {
      const directory = await (target ?? historyOnly).getDirectory();
      const availableHarnesses = new Set([
        ...(input.target.available && input.nativeOwner ? ["zcode"] : []),
        ...(input.target.available && input.allowNewSessions()
          ? ["pi", "codex", "claude-code", "devin"]
          : []),
      ]);
      return harnessDirectorySnapshotSchema.parse({
        schemaVersion: 1,
        targetId: input.target.id,
        status: input.target.available ? "available" : "unavailable",
        entries: [...directory.list()].map((entry) => ({
          ...entry,
          status: availableHarnesses.has(entry.manifest.id) ? "registered" : "unavailable",
        })),
      });
    },
    async getHarnessAsset(assetId) {
      return readHarnessStaticAsset(assetId);
    },
    async listSessionSummaries(workspaceIdentity, worktreePath) {
      return (target ?? historyOnly).listSessionSummaries(workspaceIdentity, worktreePath);
    },
    async listActivityIndex() {
      return (target ?? historyOnly).listActivityIndex();
    },
    async create(spec) {
      if (!input.allowNewSessions())
        throw new Error("new external sessions disabled; existing history remains readable");
      return (await getTarget()).create(spec);
    },
    async attach(spec) {
      return (await getTarget()).attach(spec);
    },
    async dispatch(spec, command) {
      return (await getTarget()).dispatch(spec, command);
    },
    async snapshot(spec) {
      return (target ?? historyOnly).snapshot(spec);
    },
    async eventsSince(spec, sequence) {
      return (target ?? historyOnly).eventsSince(spec, sequence);
    },
    async queryCommand(spec, commandId) {
      return (target ?? historyOnly).queryCommand(spec, commandId);
    },
    async createExternalSession(request) {
      if (!input.allowNewSessions())
        throw new Error("new external sessions disabled; existing history remains readable");
      return conversation.createExternalSession(request);
    },
    async createExternalForWorkspace(raw) {
      if (!input.allowNewSessions())
        throw new Error("new external sessions disabled; existing history remains readable");
      return (await getTarget()).createExternalForWorkspace(raw);
    },
    async createWorkspaceSession(request) {
      if (request.harnessId === "zcode") {
        if (!input.nativeOwner) throw new Error("native-workspace-session-owner-unavailable");
        return historyOnly.createWorkspaceSession(request);
      }
      if (!input.allowNewSessions())
        throw new Error("new external sessions disabled; existing history remains readable");
      return (await getTarget()).createWorkspaceSession(request);
    },
    async getWorkspaceSessionCapability(request: WorkspaceSessionBindingCapabilityRequest) {
      if (request.harnessId === "zcode") {
        return withCredentialAttention(
          request,
          await historyOnly.getWorkspaceSessionCapability(request),
        );
      }
      if (!input.target.available || !input.allowNewSessions()) {
        return withCredentialAttention(
          request,
          workspaceSessionBindingCapabilityResultSchema.parse({
            targetId: input.target.id,
            report: {
              support: "unsupported",
              reason: input.target.available ? "admission-disabled" : "target-unavailable",
            },
          }),
        );
      }
      return (await getTarget()).getWorkspaceSessionCapability(request);
    },
    async listWorkspaceSessionOwners(request) {
      return (target ?? historyOnly).listWorkspaceSessionOwners(request);
    },
    subscribeConversation: (request) => conversation.subscribeConversation(request),
    resyncConversation: (request) => conversation.resyncConversation(request),
    unsubscribeConversation: (request) => conversation.unsubscribeConversation(request),
    conversationRowsRange: (request) => conversation.conversationRowsRange(request),
  };
  return {
    service,
    targetModelGateway,
    dispose() {
      // A second dispose shares the first one's outcome instead of re-running the closes.
      disposing ??= (async () => {
        disposed = true;
        conversationFrameSubscription.dispose();
        conversation.dispose();
        targetDispose?.();
        events.dispose();
        conversationFrames.dispose();
        // Process shutdown with an active turn leaves durable accepted/unknown; no
        // fabricated completion or implicit prompt replay on the next target epoch.
        // Codex 与 Claude 共用注入的同一个按目标 Gateway，二者都不拥有它（harness shutdown 不关它），
        // 所以由这里在 target.close()（含 harness shutdown）之后关闭；目标从未 warm 时也照样关闭。
        // ssh-disconnect 不会走到 dispose。
        // Each close runs even if an earlier one rejected. target.close() first closes every
        // mounted host (AgentHostTargetService.#finishClose -> closeSessionHosts); a host close
        // refused only by a starting send is retried once after whenStartingSendsSettled().
        // Exactly one host failure is rethrown unchanged, so typed errors (EventStreamFailure...)
        // stay matchable; two or more reject with TargetHostsCloseError (an AggregateError, code
        // "target-close-failed", `errors` and `failures` {hostSessionId, error} in close order).
        // This loop still rethrows its own first failure as is; later ones are logged.
        let failed = false;
        let failure: unknown;
        const closes: [string, () => Promise<void> | undefined][] = [
          ["target", () => target?.close()],
          ["target model gateway", () => targetModelGateway.close()],
          ["history-only", () => historyOnly.close()],
        ];
        for (const [name, close] of closes) {
          try {
            await close();
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            } else {
              logger.warn(undefined, "agent host dispose: later close failed", { name, error });
            }
          }
        }
        if (failed) throw failure;
      })();
      return disposing;
    },
  };
}
