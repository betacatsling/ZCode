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
import { TargetModelGateway } from "@zcode/services/model-gateway";
import type { HarnessAdapter, PreparedHostBinding } from "../../agent-host/harnessRegistry.js";
import {
  claudeHarnessCapabilities,
  claudeHostManagedSupport,
  type ClaudeFakeModelCompatibilityEvidence,
} from "./claudeCapabilities.js";
import { PINNED_CLAUDE_CLI_VERSION, probeClaudeTarget } from "./claudeExecutable.js";
import { writeClaudeSessionCapability } from "./claudeProfile.js";
import { denyPendingClaudeApprovals, resolveClaudeApproval } from "./claudeHostApproval.js";
import { ClaudeSessionRegistry } from "./claudeSessionRegistry.js";
import { ClaudeRuntimeEventSink } from "./claudeRuntimeEventSink.js";
import { type ClaudeSessionRuntime } from "./claudeRuntime.js";
import { ClaudeStreamProcess } from "./claudeStreamProcess.js";
import { ClaudeTurnLifecycle } from "./claudeTurnLifecycle.js";
import { validateClaudePlan } from "./claudeBindingGuards.js";
import {
  finishClaudeTurn,
  markClaudeTurnUnknown,
  stopClaudeRuntime,
} from "./claudeRuntimeOutcome.js";
import {
  replaceClaudeIdleBinding,
  startClaudeSession,
  type ClaudeSessionStartupContext,
} from "./claudeSessionStartup.js";

export { CLAUDE_PUBLIC_MODEL_ID } from "./claudeSessionStartup.js";

export interface ClaudeHarnessAdapterOptions {
  readonly root: string;
  readonly executablePath?: string;
  readonly targetModelGateway?: TargetModelGateway;
  readonly modelFactory: (spec: SessionSpec, plan: BindingPlan) => Promise<Model> | Model;
  readonly isMessagesSelection: (selection: ModelSelection) => boolean;
  readonly fakeModelCompatibilityEvidence?: (
    selection: ModelSelection,
  ) => ClaudeFakeModelCompatibilityEvidence | undefined;
  readonly isSelectionAuthorized?: (plan: BindingPlan) => boolean;
  readonly now?: () => number;
  readonly turnLeaseRenewIntervalMs?: number;
  readonly onProcess?: (hostSessionId: string, process: ClaudeStreamProcess) => void;
}

/** Explicit 2.1.263 structured-stream adapter; SessionHost retains admission and journal ownership. */
export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  readonly version = PINNED_CLAUDE_CLI_VERSION;
  readonly hostManagedRoute = "messages-gateway" as const;
  readonly #root: string;
  readonly #executablePath?: string;
  readonly #modelFactory: ClaudeHarnessAdapterOptions["modelFactory"];
  readonly #isMessagesSelection: ClaudeHarnessAdapterOptions["isMessagesSelection"];
  readonly #fakeEvidence: ClaudeHarnessAdapterOptions["fakeModelCompatibilityEvidence"];
  readonly #isSelectionAuthorized: NonNullable<
    ClaudeHarnessAdapterOptions["isSelectionAuthorized"]
  >;
  readonly #now: () => number;
  readonly #onProcess?: ClaudeHarnessAdapterOptions["onProcess"];
  readonly #targetGateway: TargetModelGateway;
  readonly #ownsTargetGateway: boolean;
  readonly #registry = new ClaudeSessionRegistry();
  readonly #subscriptions = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #eventSink = new ClaudeRuntimeEventSink(this.#subscriptions);
  readonly #turnLifecycle: ClaudeTurnLifecycle;
  readonly #session: ClaudeSessionStartupContext;
  #shuttingDown = false;
  #shutdownPromise?: Promise<void>;

  constructor(options: ClaudeHarnessAdapterOptions) {
    this.#root = options.root;
    this.#executablePath = options.executablePath;
    this.#modelFactory = options.modelFactory;
    this.#isMessagesSelection = options.isMessagesSelection;
    this.#fakeEvidence = options.fakeModelCompatibilityEvidence;
    this.#isSelectionAuthorized = options.isSelectionAuthorized ?? (() => true);
    this.#now = options.now ?? Date.now;
    this.#onProcess = options.onProcess;
    this.#ownsTargetGateway = options.targetModelGateway === undefined;
    this.#targetGateway = options.targetModelGateway ?? new TargetModelGateway({ now: this.#now });
    this.#session = {
      version: this.version,
      root: this.#root,
      executablePath: this.#executablePath,
      modelFactory: this.#modelFactory,
      isSelectionAuthorized: this.#isSelectionAuthorized,
      targetGateway: this.#targetGateway,
      eventSink: this.#eventSink,
      registry: this.#registry,
      onProcess: this.#onProcess,
      isShuttingDown: () => this.#shuttingDown,
      validatePlan: (spec, plan) =>
        validateClaudePlan(
          {
            adapterId: this.id,
            adapterVersion: this.version,
            hostManagedRoute: this.hostManagedRoute,
            shuttingDown: this.#shuttingDown,
            fakeEvidence: this.#fakeEvidence,
            isMessagesSelection: this.#isMessagesSelection,
          },
          spec,
          plan,
        ),
    };
    this.#turnLifecycle = new ClaudeTurnLifecycle(
      {
        adapterId: this.id,
        adapterVersion: this.version,
        hostManagedRoute: this.hostManagedRoute,
        grantLifetimeMs: this.#targetGateway.grantLifetimeMs,
        isMessagesSelection: this.#isMessagesSelection,
        isSelectionAuthorized: this.#isSelectionAuthorized,
        requireRuntime: (sessionId) => this.#require(sessionId),
        replaceIdleBinding: (runtime, prepared) =>
          replaceClaudeIdleBinding(this.#session, runtime, prepared),
        stopRuntime: (runtime) => stopClaudeRuntime(runtime),
        markUnknown: (runtime, turn, message) => markClaudeTurnUnknown(runtime, turn, message),
      },
      options.turnLeaseRenewIntervalMs,
    );
  }

  async probe(target: ExecutionTarget) {
    return probeClaudeTarget(target, this.#executablePath);
  }

  async hostManagedSupport(target: ExecutionTarget, selection: ModelSelection) {
    return claudeHostManagedSupport({
      target,
      selection,
      executablePath: this.#executablePath,
      isMessagesSelection: this.#isMessagesSelection,
      ...(this.#fakeEvidence ? { fakeModelCompatibilityEvidence: this.#fakeEvidence } : {}),
    });
  }

  async harnessManagedSupport() {
    return {
      support: "unsupported" as const,
      reason: "Native Claude account or subscription authentication is not enabled",
    };
  }

  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    return claudeHarnessCapabilities();
  }

  prepareModel(spec: SessionSpec, plan: BindingPlan): Promise<Model> | Model {
    return this.#modelFactory(spec, plan);
  }

  async create(
    spec: SessionSpec,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<BackendBinding> {
    const starting = this.#registry.reserveStart(spec.hostSessionId, () =>
      startClaudeSession(this.#session, spec, plan, undefined, 0, prepared),
    );
    try {
      const runtime = await starting;
      if (this.#shuttingDown) {
        await stopClaudeRuntime(runtime);
        throw new Error("Claude target host is shutting down");
      }
      this.#registry.add(spec.hostSessionId, runtime);
      return runtime.binding;
    } finally {
      this.#registry.releaseStart(spec.hostSessionId, starting);
    }
  }

  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    lastJournalSequence: number,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<void> {
    if (this.#shuttingDown) throw new Error("Claude target host is shutting down");
    const current = this.#registry.get(spec.hostSessionId);
    if (current) {
      if (
        current.binding.backendSessionId !== binding.backendSessionId ||
        current.binding.runtimeEpoch !== binding.runtimeEpoch
      ) {
        throw new Error("stale Claude backend binding");
      }
      if (!current.failed && current.process.isRunning) return;
      await stopClaudeRuntime(current);
      this.#registry.remove(spec.hostSessionId, current);
    }
    if (this.#registry.hasStarting(spec.hostSessionId))
      throw new Error("Claude session is already starting");
    const starting = this.#registry.reserveStart(spec.hostSessionId, () =>
      startClaudeSession(this.#session, spec, plan, binding, lastJournalSequence, prepared),
    );
    try {
      const runtime = await starting;
      if (this.#shuttingDown) {
        await stopClaudeRuntime(runtime);
        throw new Error("Claude target host is shutting down");
      }
      this.#registry.add(spec.hostSessionId, runtime);
    } finally {
      this.#registry.releaseStart(spec.hostSessionId, starting);
    }
  }

  async prepareTurn(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void> {
    return this.#turnLifecycle.prepare(spec, prepared);
  }

  async discardPreparedTurn(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void> {
    this.#turnLifecycle.discard(spec, prepared);
  }

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
      throw new Error("stale Claude turn cancellation");
    }
    const safeCancellation = turn.approvedToolIds.size === 0;
    denyPendingClaudeApprovals(runtime);
    runtime.failed = new Error("Claude turn was interrupted by its Host owner");
    runtime.gateway.revoke(runtime.grant.id);
    if (safeCancellation)
      finishClaudeTurn(runtime, turn, {
        subtype: "success",
        is_error: false,
        zcodeOutcome: "cancelled",
      });
    else
      markClaudeTurnUnknown(
        runtime,
        turn,
        "Claude was stopped after an approved tool may have started.",
      );
    await runtime.process.abort();
  }

  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    resolveClaudeApproval(runtime, command);
  }

  async terminate(hostSessionId: string): Promise<void> {
    const runtime = this.#registry.get(hostSessionId);
    if (!runtime) return;
    await stopClaudeRuntime(runtime);
    this.#registry.remove(hostSessionId, runtime);
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

  async #finishShutdown(): Promise<void> {
    const pendingStarts = this.#registry.pendingStarts();
    const started = await Promise.allSettled(pendingStarts);
    const current = new Set(this.#registry.values());
    for (const result of started) if (result.status === "fulfilled") current.add(result.value);
    await Promise.all([...current].map((runtime) => stopClaudeRuntime(runtime)));
    if (this.#ownsTargetGateway) await this.#targetGateway.close();
    this.#registry.clear();
  }

  #require(hostSessionId: string): ClaudeSessionRuntime {
    const runtime = this.#registry.get(hostSessionId);
    if (!runtime) throw new Error("Claude Host session is not attached");
    return runtime;
  }
}
