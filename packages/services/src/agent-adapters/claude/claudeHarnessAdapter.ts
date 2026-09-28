import { randomUUID } from "node:crypto";
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
import { ClaudeApprovalHookServer } from "./claudeApprovalHookServer.js";
import { claudeHarnessCapabilities, claudeHostManagedSupport, type ClaudeFakeModelCompatibilityEvidence } from "./claudeCapabilities.js";
import {
  PINNED_CLAUDE_CLI_VERSION,
  probeClaudeTarget,
  readClaudeCliVersion,
  resolveClaudeExecutable,
} from "./claudeExecutable.js";
import { createClaudeArguments, createClaudeChildEnvironment, prepareClaudeSessionProfile, writeClaudeSessionCapability } from "./claudeProfile.js";
import { denyPendingClaudeApprovals, requestClaudeApproval, resolveClaudeApproval } from "./claudeHostApproval.js";
import { translateClaudeStructuredMessage } from "./claudeRuntimeEvents.js";
import { ClaudeSessionRegistry } from "./claudeSessionRegistry.js";
import {
  ClaudeRuntimeEventSink,
} from "./claudeRuntimeEventSink.js";
import {
  type ClaudeActiveTurn,
  type ClaudeSessionRuntime,
} from "./claudeRuntime.js";
import { ClaudeStreamProcess, type ClaudeStructuredMessage } from "./claudeStreamProcess.js";
import { ClaudeTurnLifecycle } from "./claudeTurnLifecycle.js";

const CLAUDE_PUBLIC_MODEL_ID = "zcode-host";
const CLAUDE_TOOL_ALLOWLIST = ["Bash", "Edit", "Read", "Write", "Glob", "Grep"] as const;
const CLAUDE_MAX_OUTPUT_TOKENS = 32_000;

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
  readonly #isSelectionAuthorized: NonNullable<ClaudeHarnessAdapterOptions["isSelectionAuthorized"]>;
  readonly #now: () => number;
  readonly #onProcess?: ClaudeHarnessAdapterOptions["onProcess"];
  readonly #targetGateway: TargetModelGateway;
  readonly #ownsTargetGateway: boolean;
  readonly #registry = new ClaudeSessionRegistry();
  readonly #subscriptions = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #eventSink = new ClaudeRuntimeEventSink(this.#subscriptions);
  readonly #turnLifecycle: ClaudeTurnLifecycle;
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
    this.#turnLifecycle = new ClaudeTurnLifecycle(
      {
        adapterId: this.id,
        adapterVersion: this.version,
        hostManagedRoute: this.hostManagedRoute,
        grantLifetimeMs: this.#targetGateway.grantLifetimeMs,
        isMessagesSelection: this.#isMessagesSelection,
        isSelectionAuthorized: this.#isSelectionAuthorized,
        requireRuntime: (sessionId) => this.#require(sessionId),
        replaceIdleBinding: (runtime, prepared) => this.#replaceIdleBinding(runtime, prepared),
        stopRuntime: (runtime) => this.#stopRuntime(runtime),
        markUnknown: (runtime, turn, message) => this.#markUnknown(runtime, turn, message),
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
      this.#startSession(spec, plan, undefined, 0, prepared),
    );
    try {
      const runtime = await starting;
      if (this.#shuttingDown) {
        await this.#stopRuntime(runtime);
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
      await this.#stopRuntime(current);
      this.#registry.remove(spec.hostSessionId, current);
    }
    if (this.#registry.hasStarting(spec.hostSessionId))
      throw new Error("Claude session is already starting");
    const starting = this.#registry.reserveStart(spec.hostSessionId, () =>
      this.#startSession(spec, plan, binding, lastJournalSequence, prepared),
    );
    try {
      const runtime = await starting;
      if (this.#shuttingDown) {
        await this.#stopRuntime(runtime);
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
      this.#finishTurn(runtime, turn, { subtype: "success", is_error: false, zcodeOutcome: "cancelled" });
    else this.#markUnknown(runtime, turn, "Claude was stopped after an approved tool may have started.");
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
    await this.#stopRuntime(runtime);
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

  async #startSession(
    spec: SessionSpec,
    plan: BindingPlan,
    priorBinding: BackendBinding | undefined,
    sequence: number,
    prepared?: PreparedHostBinding,
  ): Promise<ClaudeSessionRuntime> {
    if (prepared && prepared.plan !== plan) throw new Error("Claude startup received another prepared plan");
    this.#validatePlan(spec, plan);
    const executablePath = await resolveClaudeExecutable(this.#executablePath);
    const version = await readClaudeCliVersion(executablePath);
    if (version !== this.version) throw new Error("Claude Code CLI version does not match 2.1.263");
    const model = prepared?.model ?? (await this.#modelFactory(spec, plan));
    this.#validateModel(plan, model);
    if (!this.#isSelectionAuthorized(plan)) throw new Error("Claude Model selection is no longer authorized");
    const guardedModel = guardClaudeModel(model, plan, this.#isSelectionAuthorized);
    const gateway = this.#targetGateway.get(plan.targetId);
    await gateway.start();
    const maxOutputTokens = Math.min(
      model.options.maxOutputTokens ?? model.optionSpecs.maxOutputTokens.max,
      CLAUDE_MAX_OUTPUT_TOKENS,
    );
    const effort = plan.effective?.options?.reasoningLevel;
    if (!effort) throw new Error("Claude Model binding has no selected effort level");
    const grant = gateway.createGrant({
      protocol: "anthropic-messages",
      sessionId: spec.hostSessionId,
      modelBindingFingerprint: plan.catalogFingerprint,
      publicModelId: CLAUDE_PUBLIC_MODEL_ID,
      model: guardedModel,
      expiresInMs: this.#targetGateway.grantLifetimeMs,
      limits: {
        maxBodyBytes: 1024 * 1024,
        maxRequests: 2_000,
        maxConcurrent: 2,
        maxOutputTokens: 1_000_000,
        maxOutputTokensPerRequest: maxOutputTokens,
      },
    });
    const nativeSessionId = priorBinding?.backendSessionId ?? randomUUID();
    const binding = priorBinding ?? {
      hostSessionId: spec.hostSessionId,
      backendSessionId: nativeSessionId,
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    };
    if (binding.backendVersion !== this.version || binding.hostSessionId !== spec.hostSessionId) {
      gateway.revoke(grant.id);
      throw new Error("Claude backend binding version or owner differs");
    }

    let runtime: ClaudeSessionRuntime | undefined;
    let earlyFailure: Error | undefined;
    const earlyMessages: ClaudeStructuredMessage[] = [];
    const hookServer = new ClaudeApprovalHookServer((input, signal) =>
      runtime ? requestClaudeApproval(runtime, input, signal) : Promise.resolve("deny"),
    );
    let process: ClaudeStreamProcess | undefined;
    try {
      const hookUrl = await hookServer.start();
      const profile = await prepareClaudeSessionProfile({
        root: this.#root,
        spec,
        gatewayBaseUrl: grant.baseUrl,
        gatewayToken: grant.token,
        hookUrl,
        modelAlias: grant.publicModelId,
        effort,
        maxOutputTokens,
      });
      process = new ClaudeStreamProcess({
        executablePath,
        args: createClaudeArguments({
          executablePath,
          profile,
          nativeSessionId,
          resume: priorBinding !== undefined,
          tools: CLAUDE_TOOL_ALLOWLIST,
        }),
        cwd: profile.cwd,
        env: createClaudeChildEnvironment({ profile, executablePath }),
        onMessage: (message) => {
          if (runtime) this.#translate(runtime, message);
          else earlyMessages.push(message);
        },
        onFailure: (error) => {
          if (runtime) this.#failRuntime(runtime, error);
          else earlyFailure = error;
        },
      });
      runtime = this.#eventSink.createRuntime({
        spec,
        plan,
        binding,
        model: guardedModel,
        gateway,
        grant,
        profile,
        process,
        hookServer,
        sequence,
      });
      this.#onProcess?.(spec.hostSessionId, process);
      for (const message of earlyMessages) this.#translate(runtime, message);
      if (earlyFailure) this.#failRuntime(runtime, earlyFailure);
      if (!this.#isSelectionAuthorized(plan)) {
        runtime.failed = new Error("Claude Model selection was revoked during process startup");
        await this.#stopRuntime(runtime);
        throw runtime.failed;
      }
      return runtime;
    } catch (error) {
      gateway.revoke(grant.id);
      if (process?.isRunning) await process.terminate();
      await hookServer.close();
      if (runtime) this.#registry.remove(spec.hostSessionId, runtime);
      throw error;
    }
  }

  async #replaceIdleBinding(
    previous: ClaudeSessionRuntime,
    prepared: PreparedHostBinding,
  ): Promise<ClaudeSessionRuntime> {
    if (previous.activeTurn || previous.preparedTurnId)
      throw new Error("Claude cannot replace its Model binding during an active turn");
    await this.#stopRuntime(previous);
    this.#registry.remove(previous.spec.hostSessionId, previous);
    const starting = this.#registry.reserveStart(previous.spec.hostSessionId, () =>
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
        throw new Error("Claude target host is shutting down");
      }
      this.#registry.add(previous.spec.hostSessionId, rebound);
      return rebound;
    } catch (error) {
      previous.stopping = false;
      previous.failed = error instanceof Error ? error : new Error("Claude rebind failed");
      this.#registry.add(previous.spec.hostSessionId, previous);
      throw error;
    } finally {
      this.#registry.releaseStart(previous.spec.hostSessionId, starting);
    }
  }

  #translate(runtime: ClaudeSessionRuntime, message: ClaudeStructuredMessage): void {
    translateClaudeStructuredMessage(
      runtime,
      message,
      (current, turn, result) => this.#finishTurn(current, turn, result),
      (current, messageText) => this.#failRuntime(current, new Error(messageText)),
    );
  }

  #finishTurn(runtime: ClaudeSessionRuntime, turn: ClaudeActiveTurn, result: Record<string, unknown>): void {
    if (runtime.activeTurn !== turn) return;
    const outcome = result.zcodeOutcome === "cancelled"
      ? "cancelled"
      : result.is_error === true || result.subtype !== "success"
        ? "failed"
        : "success";
    const failed = outcome === "failed";
    if (!turn.started) {
      turn.started = true;
      runtime.emit("turn.started", { turnId: turn.hostTurnId });
    }
    if (failed)
      runtime.emit("session.error", {
        code: "claude-turn-failed",
        message: "Claude Code reported that the accepted turn failed.",
      });
    const usage = asRecord(result.usage);
    const baseInput = safeTokenCount(usage?.input_tokens);
    const cacheRead = safeTokenCount(usage?.cache_read_input_tokens) ?? 0;
    const cacheCreate = safeTokenCount(usage?.cache_creation_input_tokens) ?? 0;
    const output = safeTokenCount(usage?.output_tokens);
    if (baseInput !== undefined && output !== undefined) {
      runtime.emit("usage.reported", {
        turnId: turn.hostTurnId,
        inputTokens: baseInput + cacheRead + cacheCreate,
        outputTokens: output,
      });
    }
    runtime.emit("turn.finished", {
      turnId: turn.hostTurnId,
      outcome,
    });
    denyPendingClaudeApprovals(runtime);
    runtime.activeTurn = undefined;
    runtime.toolCalls.clear();
    runtime.toolBlocks.clear();
    runtime.activeNativeMessageId = undefined;
    runtime.resolvedInteractionIds.clear();
    runtime.emit("session.status", { state: "idle" });
    turn.completion.resolve();
  }

  #markUnknown(runtime: ClaudeSessionRuntime, turn: ClaudeActiveTurn, message: string): void {
    if (runtime.activeTurn !== turn) return;
    if (!turn.started) {
      turn.started = true;
      runtime.emit("turn.started", { turnId: turn.hostTurnId });
    }
    runtime.emit("session.error", { code: "execution-unknown", message });
    runtime.emit("turn.finished", { turnId: turn.hostTurnId, outcome: "unknown" });
    denyPendingClaudeApprovals(runtime);
    runtime.activeTurn = undefined;
    runtime.failed = new Error("Claude accepted input may have executed; inspect history before recovery");
    runtime.toolCalls.clear();
    runtime.toolBlocks.clear();
    turn.completion.reject(runtime.failed);
  }

  #failRuntime(runtime: ClaudeSessionRuntime, error: Error): void {
    if (runtime.stopping || runtime.failed) return;
    runtime.failed = error;
    runtime.gateway.revoke(runtime.grant.id);
    if (runtime.activeTurn) {
      this.#markUnknown(
        runtime,
        runtime.activeTurn,
        "Claude Code stopped before confirming the accepted turn outcome.",
      );
    } else {
      runtime.emit("session.error", {
        code: "claude-process-failure",
        message: "Claude Code process exited unexpectedly; resume will not resend Host input.",
      });
    }
    denyPendingClaudeApprovals(runtime);
  }

  async #stopRuntime(runtime: ClaudeSessionRuntime): Promise<void> {
    if (runtime.stopPromise) return runtime.stopPromise;
    if (runtime.stopping) return;
    runtime.stopping = true;
    if (runtime.activeTurn)
      this.#markUnknown(runtime, runtime.activeTurn, "Claude session stopped before its turn outcome was known.");
    denyPendingClaudeApprovals(runtime);
    if (runtime.turnLeaseTimer) clearInterval(runtime.turnLeaseTimer);
    runtime.gateway.revoke(runtime.grant.id);
    runtime.stopPromise = (async () => {
      await runtime.hookServer.close();
      await runtime.process.terminate();
    })();
    await runtime.stopPromise;
  }

  async #finishShutdown(): Promise<void> {
    const pendingStarts = this.#registry.pendingStarts();
    const started = await Promise.allSettled(pendingStarts);
    const current = new Set(this.#registry.values());
    for (const result of started) if (result.status === "fulfilled") current.add(result.value);
    await Promise.all([...current].map((runtime) => this.#stopRuntime(runtime)));
    if (this.#ownsTargetGateway) await this.#targetGateway.close();
    this.#registry.clear();
  }

  #validatePlan(spec: SessionSpec, plan: BindingPlan): void {
    const selection = plan.effective;
    if (!selection) throw new Error("Claude Model binding is missing its effective selection");
    const evidence = this.#fakeEvidence?.(selection);
    if (
      this.#shuttingDown ||
      spec.harness.id !== this.id ||
      spec.harness.adapterVersion !== this.version ||
      plan.hostSessionId !== spec.hostSessionId ||
      plan.harnessId !== this.id ||
      plan.adapterVersion !== this.version ||
      plan.targetId !== spec.execution.targetId ||
      plan.route !== this.hostManagedRoute ||
      plan.support.support !== "supported" ||
      spec.modelBinding.kind !== "host-managed" ||
      JSON.stringify(plan.requested) !== JSON.stringify(spec.modelBinding) ||
      !this.#isMessagesSelection(selection) ||
      !evidence ||
      evidence.providerId !== selection.providerId ||
      evidence.modelId !== selection.modelId ||
      plan.support.constraints?.compatibilityEvidence !== "fake-model-fixture" ||
      plan.support.constraints.fixtureId !== evidence.fixtureId
    ) {
      throw new Error("Claude session requires exact pinned FakeModel Messages compatibility evidence");
    }
  }

  #validateModel(plan: BindingPlan, model: Model): void {
    if (
      !plan.effective ||
      model.providerId !== plan.effective.providerId ||
      model.modelId !== plan.effective.modelId ||
      model.options.reasoningLevel !== plan.effective.options?.reasoningLevel ||
      !["low", "medium", "high", "xhigh", "max"].includes(model.options.reasoningLevel ?? "")
    ) {
      throw new Error("Claude Model differs from its captured Messages binding or effort");
    }
  }

  #require(hostSessionId: string): ClaudeSessionRuntime {
    const runtime = this.#registry.get(hostSessionId);
    if (!runtime) throw new Error("Claude Host session is not attached");
    return runtime;
  }
}

function guardClaudeModel(
  model: Model,
  plan: BindingPlan,
  isSelectionAuthorized: (plan: BindingPlan) => boolean,
): Model {
  const assertAuthorized = () => {
    if (!isSelectionAuthorized(plan))
      throw new Error("Claude Model selection is no longer authorized; request refused");
  };
  const guard = (bound: Model): Model => ({
    providerId: bound.providerId,
    modelId: bound.modelId,
    ...(bound.displayName ? { displayName: bound.displayName } : {}),
    properties: bound.properties,
    optionSpecs: bound.optionSpecs,
    options: bound.options,
    bind: (options) => guard(bound.bind(options)),
    generateText: (request) => {
      assertAuthorized();
      return bound.generateText(request);
    },
    streamText: (request) => {
      assertAuthorized();
      return bound.streamText(request);
    },
  });
  return guard(model);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
