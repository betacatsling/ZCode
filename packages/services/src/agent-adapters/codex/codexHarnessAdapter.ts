import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type BindingPlan,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter, PreparedHostBinding } from "../../agent-host/harnessRegistry.js";
import { TargetModelGateway } from "@zcode/services/model-gateway";
import { resolveCodexApproval } from "./codexApprovalResolution.js";
import { CodexAppServerProcess } from "./codexAppServerProcess.js";
import {
  HOST_APPROVAL_POLICY,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codexProfile.js";
import type { CodexSessionRuntime } from "./codexRuntime.js";
import { CodexRuntimeEvents } from "./codexRuntimeEvents.js";
import { CodexSessionRegistry } from "./codexSessionRegistry.js";
import { CodexTargetGateway } from "./codexTargetGateway.js";
import { createCodexHarnessSession } from "./codexSessionFactory.js";
import { CodexTurnLifecycle } from "./codexTurnLifecycle.js";
import {
  codexHarnessCapabilities,
  codexHostManagedSupport,
  probeCodexTarget,
  type FakeModelCompatibilityEvidence,
} from "./codexCapabilities.js";

export interface CodexHarnessAdapterOptions {
  readonly root: string;
  readonly executablePath?: string;
  readonly targetModelGateway?: TargetModelGateway;
  readonly modelFactory: (spec: SessionSpec, plan: BindingPlan) => Promise<Model> | Model;
  readonly isOpenAiResponsesSelection: (selection: ModelSelection) => boolean;
  readonly fakeModelCompatibilityEvidence?: (
    selection: ModelSelection,
  ) => FakeModelCompatibilityEvidence | undefined;
  readonly isSelectionAuthorized?: (plan: BindingPlan) => boolean;
  /** @deprecated use isSelectionAuthorized; this callback must check selection validity only. */
  readonly isBindingCurrent?: (plan: BindingPlan) => boolean;
  readonly now?: () => number;
  readonly sandboxMode?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalPolicy;
  readonly onProcess?: (hostSessionId: string, process: CodexAppServerProcess) => void;
  readonly onStderr?: (hostSessionId: string, chunk: string) => void;
}

/** Pinned, target-local app-server adapter; it owns no accepted-input queue or Host journal. */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly version = "0.157.1";
  readonly hostManagedRoute = "responses-gateway" as const;
  readonly #root: string;
  readonly #executablePath?: string;
  readonly #modelFactory: CodexHarnessAdapterOptions["modelFactory"];
  readonly #isOpenAiResponsesSelection: CodexHarnessAdapterOptions["isOpenAiResponsesSelection"];
  readonly #fakeModelCompatibilityEvidence: CodexHarnessAdapterOptions["fakeModelCompatibilityEvidence"];
  readonly #isSelectionAuthorized: NonNullable<CodexHarnessAdapterOptions["isSelectionAuthorized"]>;
  readonly #now: () => number;
  readonly #sandboxMode: CodexSandboxMode;
  readonly #approvalPolicy: CodexApprovalPolicy;
  readonly #onProcess?: CodexHarnessAdapterOptions["onProcess"];
  readonly #onStderr?: CodexHarnessAdapterOptions["onStderr"];
  readonly #sessionRegistry = new CodexSessionRegistry();
  readonly #subscriptions = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #events: CodexRuntimeEvents;
  readonly #targetGateway: TargetModelGateway;
  readonly #ownsTargetGateway: boolean;
  readonly #turnLifecycle: CodexTurnLifecycle;
  #shuttingDown = false;
  #shutdownPromise?: Promise<void>;

  constructor(options: CodexHarnessAdapterOptions) {
    this.#events = new CodexRuntimeEvents(this.#subscriptions);
    this.#root = options.root;
    this.#executablePath = options.executablePath;
    this.#modelFactory = options.modelFactory;
    this.#isOpenAiResponsesSelection = options.isOpenAiResponsesSelection;
    this.#fakeModelCompatibilityEvidence = options.fakeModelCompatibilityEvidence;
    this.#now = options.now ?? Date.now;
    this.#isSelectionAuthorized =
      options.isSelectionAuthorized ?? options.isBindingCurrent ?? (() => true);
    this.#ownsTargetGateway = options.targetModelGateway === undefined;
    this.#targetGateway = options.targetModelGateway ?? new CodexTargetGateway({ now: this.#now });
    this.#sandboxMode = options.sandboxMode ?? "workspace-write";
    this.#approvalPolicy = options.approvalPolicy ?? HOST_APPROVAL_POLICY;
    this.#onProcess = options.onProcess;
    this.#onStderr = options.onStderr;
    this.#turnLifecycle = new CodexTurnLifecycle({
      adapterId: this.id,
      adapterVersion: this.version,
      hostManagedRoute: this.hostManagedRoute,
      isOpenAiResponsesSelection: this.#isOpenAiResponsesSelection,
      isSelectionAuthorized: this.#isSelectionAuthorized,
      requireRuntime: (hostSessionId) => this.#require(hostSessionId),
      replaceIdleBinding: (runtime, prepared) => this.#replaceIdleBinding(runtime, prepared),
      stopRuntime: (runtime) => this.#stopRuntime(runtime),
      markUnknown: (runtime, turn, message) => this.#events.markUnknown(runtime, turn, message),
    });
  }

  async probe(target: ExecutionTarget) {
    return probeCodexTarget(target, this.#executablePath);
  }

  async hostManagedSupport(target: ExecutionTarget, selection: ModelSelection) {
    return codexHostManagedSupport({
      target,
      selection,
      executablePath: this.#executablePath,
      adapterVersion: this.version,
      isOpenAiResponsesSelection: this.#isOpenAiResponsesSelection,
      ...(this.#fakeModelCompatibilityEvidence
        ? { fakeModelCompatibilityEvidence: this.#fakeModelCompatibilityEvidence }
        : {}),
    });
  }

  async harnessManagedSupport(_target: ExecutionTarget) {
    return {
      support: "unsupported" as const,
      reason: "Native Codex account auth is not enabled by the experimental adapter",
    };
  }

  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    return codexHarnessCapabilities();
  }

  prepareModel(spec: SessionSpec, plan: BindingPlan): Promise<Model> | Model {
    return this.#modelFactory(spec, plan);
  }

  async create(
    spec: SessionSpec,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<BackendBinding> {
    const starting = this.#sessionRegistry.reserveStart(spec.hostSessionId, () =>
      this.#startSession(spec, plan, undefined, 0, prepared),
    );
    try {
      const runtime = await starting;
      if (this.#shuttingDown) {
        await this.#stopRuntime(runtime);
        throw new Error("Codex target host is shutting down");
      }
      this.#sessionRegistry.add(spec.hostSessionId, runtime);
      return runtime.binding;
    } finally {
      this.#sessionRegistry.releaseStart(spec.hostSessionId, starting);
    }
  }

  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    lastJournalSequence: number,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<void> {
    if (this.#shuttingDown) throw new Error("Codex target host is shutting down");
    const existing = this.#sessionRegistry.get(spec.hostSessionId);
    if (existing) {
      if (
        existing.binding.backendSessionId !== binding.backendSessionId ||
        existing.binding.runtimeEpoch !== binding.runtimeEpoch
      ) {
        throw new Error("stale Codex binding");
      }
      if (!existing.failed) return;
      await this.#stopRuntime(existing);
      this.#sessionRegistry.remove(spec.hostSessionId, existing);
    }
    if (this.#sessionRegistry.hasStarting(spec.hostSessionId))
      throw new Error("Codex session is already starting");
    const starting = this.#sessionRegistry.reserveStart(spec.hostSessionId, () =>
      this.#startSession(spec, plan, binding, lastJournalSequence, prepared),
    );
    try {
      const runtime = await starting;
      if (this.#shuttingDown) {
        await this.#stopRuntime(runtime);
        throw new Error("Codex target host is shutting down");
      }
      this.#sessionRegistry.add(spec.hostSessionId, runtime);
    } finally {
      this.#sessionRegistry.releaseStart(spec.hostSessionId, starting);
    }
  }

  async prepareTurn(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void> {
    return this.#turnLifecycle.prepare(spec, prepared);
  }

  async discardPreparedTurn(_spec: SessionSpec, prepared: PreparedHostBinding): Promise<void> {
    return this.#turnLifecycle.discard(_spec, prepared);
  }

  /** Target-local renewal entry point; the timer and deterministic tests use this same fence. */
  renewTurnLease(hostSessionId: string, turnId: string): { readonly expiresAt: number } {
    return this.#turnLifecycle.renew(hostSessionId, turnId);
  }

  async send(
    command: Extract<AgentCommand, { type: "send" }>,
    prepared?: PreparedHostBinding,
  ): Promise<void> {
    return this.#turnLifecycle.send(command, prepared);
  }

  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    const turn = runtime.activeTurn;
    if (
      runtime.binding.runtimeEpoch !== command.runtimeEpoch ||
      !turn ||
      turn.hostTurnId !== command.turnId
    ) {
      throw new Error("stale Codex turn cancellation");
    }
    if (!turn.backendTurnId && turn.startRequest) await turn.startRequest;
    if (runtime.activeTurn !== turn || !turn.backendTurnId)
      throw new Error("Codex turn is no longer current");
    await runtime.process.request("turn/interrupt", {
      threadId: runtime.threadId,
      turnId: turn.backendTurnId,
    });
  }

  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    return resolveCodexApproval(runtime, command, (error) => this.#events.fail(runtime, error));
  }

  async terminate(hostSessionId: string): Promise<void> {
    const runtime = this.#sessionRegistry.get(hostSessionId);
    if (runtime) {
      await this.#stopRuntime(runtime);
      this.#sessionRegistry.remove(hostSessionId, runtime);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
  }

  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    let listeners = this.#subscriptions.get(hostSessionId);
    if (!listeners) {
      listeners = new Set();
      this.#subscriptions.set(hostSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.#subscriptions.delete(hostSessionId);
    };
  }

  async #startSession(
    spec: SessionSpec,
    plan: BindingPlan,
    priorBinding: BackendBinding | undefined,
    sequence: number,
    prepared?: PreparedHostBinding,
  ): Promise<CodexSessionRuntime> {
    if (prepared && prepared.plan !== plan)
      throw new Error("Codex startup received a different prepared binding plan");
    return createCodexHarnessSession({
      root: this.#root,
      ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
      spec,
      plan,
      ...(priorBinding ? { priorBinding } : {}),
      sequence,
      adapterId: this.id,
      adapterVersion: this.version,
      hostManagedRoute: this.hostManagedRoute,
      modelFactory: this.#modelFactory,
      ...(prepared?.model ? { preparedModel: prepared.model } : {}),
      isOpenAiResponsesSelection: this.#isOpenAiResponsesSelection,
      isSelectionAuthorized: this.#isSelectionAuthorized,
      getGateway: (targetId) => this.#targetGateway.get(targetId),
      sandboxMode: this.#sandboxMode,
      approvalPolicy: this.#approvalPolicy,
      events: this.#events,
      ...(this.#onProcess ? { onProcess: this.#onProcess } : {}),
      ...(this.#onStderr ? { onStderr: this.#onStderr } : {}),
    });
  }

  async #replaceIdleBinding(
    previous: CodexSessionRuntime,
    prepared: PreparedHostBinding,
  ): Promise<CodexSessionRuntime> {
    if (previous.activeTurn || previous.preparedTurnId)
      throw new Error("Codex cannot rebind a Gateway grant during an active Host turn");
    if (!prepared.model || !prepared.turnId)
      throw new Error("Codex rebind requires a frozen Model and Host turn ID");
    const hostSessionId = previous.spec.hostSessionId;
    previous.stopping = true;
    previous.gateway.revoke(previous.grant.id);
    await previous.process.terminate();
    this.#sessionRegistry.remove(hostSessionId, previous);
    const starting = this.#sessionRegistry.reserveStart(hostSessionId, () =>
      this.#startSession(
        previous.spec,
        prepared.plan,
        previous.binding,
        previous.sequence.value,
        prepared,
      ),
    );
    try {
      const rebound = await starting;
      if (this.#shuttingDown) {
        await this.#stopRuntime(rebound);
        throw new Error("Codex target host is shutting down");
      }
      this.#sessionRegistry.add(hostSessionId, rebound);
      return rebound;
    } catch (error) {
      // Resuming never replays input. Retain the closed owner so a later admitted send can retry.
      previous.stopping = false;
      previous.failed = undefined;
      this.#sessionRegistry.add(hostSessionId, previous);
      throw error;
    } finally {
      this.#sessionRegistry.releaseStart(hostSessionId, starting);
    }
  }

  async #stopRuntime(runtime: CodexSessionRuntime): Promise<void> {
    if (runtime.stopPromise) return runtime.stopPromise;
    if (runtime.stopping) return;
    runtime.stopping = true;
    if (runtime.activeTurn)
      this.#events.markUnknown(
        runtime,
        runtime.activeTurn,
        "Codex session stopped before the accepted turn outcome was known.",
      );
    runtime.gateway.revoke(runtime.grant.id);
    if (!runtime.failed) this.#sessionRegistry.remove(runtime.spec.hostSessionId, runtime);
    runtime.stopPromise = runtime.process.terminate();
    await runtime.stopPromise;
  }

  async #finishShutdown(): Promise<void> {
    const pendingStarts = this.#sessionRegistry.pendingStarts();
    const started = await Promise.allSettled(pendingStarts);
    const current = new Set(this.#sessionRegistry.values());
    for (const result of started) if (result.status === "fulfilled") current.add(result.value);
    await Promise.all([...current].map((runtime) => this.#stopRuntime(runtime)));
    if (this.#ownsTargetGateway) await this.#targetGateway.close();
    this.#sessionRegistry.clear();
  }

  #require(hostSessionId: string): CodexSessionRuntime {
    const runtime = this.#sessionRegistry.get(hostSessionId);
    if (!runtime) throw new Error("Codex Host session is not attached");
    return runtime;
  }
}
