import { randomUUID } from "node:crypto";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  backendBindingSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type BindingPlan,
  type CapabilityReport,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../agent-host/harnessRegistry.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { ClaudeCodeAdapterError } from "./claudeCodeErrors.js";
import type { ClaudeCodeTransport } from "./claudeCodeFakeTransport.js";
import {
  createMockClaudeCodeModelBindingPort,
  reportClaudeCodeModelChain,
  type ClaudeCodeModelBindingPort,
  type ClaudeCodeModelChainReport,
} from "./claudeCodeModelReport.js";
import {
  claudeCodeWorkspaceKey,
  planClaudeCodeProfile,
  type ClaudeCodeProfileSink,
} from "./claudeCodeProfile.js";
import { ClaudeCodeSessionRunner, type ClaudeCodeSessionState } from "./claudeCodeSession.js";
import { CLAUDE_CODE_ADAPTER_ID, CLAUDE_CODE_ADAPTER_VERSION } from "./claudeCodeVersion.js";

const logger = createServiceLogger("claude-code-adapter");

interface ClaudeCodeRuntime {
  readonly spec: SessionSpec;
  readonly state: ClaudeCodeSessionState;
  model: ClaudeCodeModelChainReport;
}

export interface ClaudeCodeSeparatedReport {
  readonly controlPlane: CapabilityReport;
  readonly hostManagedModelChain: ClaudeCodeModelChainReport;
}

export interface ClaudeCodeHarnessOptions {
  readonly managedRoot: string;
  readonly userHome: string;
  readonly transport: ClaudeCodeTransport;
  readonly modelBindingPort?: ClaudeCodeModelBindingPort;
  readonly profileSink: ClaudeCodeProfileSink;
  readonly now?: () => number;
  readonly secrets?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

const CONTROL_SUPPORTED: CapabilityReport = {
  support: "supported",
  constraints: { plane: "control", liveClaude: false, credentialsRequired: false },
};

function unsupported(reason: string): CapabilityReport {
  return { support: "unsupported", reason };
}

/** Control-plane adapter. Model certification stays on the injected port. */
export class ClaudeCodeHarnessAdapter implements HarnessAdapter {
  readonly id = CLAUDE_CODE_ADAPTER_ID;
  readonly version = CLAUDE_CODE_ADAPTER_VERSION;
  /** Used only after hostManagedSupport is supported. Default mock never reaches that. */
  readonly hostManagedRoute = "messages-gateway" as const;
  readonly #options: ClaudeCodeHarnessOptions;
  readonly #port: ClaudeCodeModelBindingPort;
  readonly #now: () => number;
  readonly #secrets: readonly string[];
  readonly #runtimes = new Map<string, ClaudeCodeRuntime>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #runner: ClaudeCodeSessionRunner;

  constructor(options: ClaudeCodeHarnessOptions) {
    this.#options = options;
    this.#port = options.modelBindingPort ?? createMockClaudeCodeModelBindingPort();
    this.#now = options.now ?? Date.now;
    this.#secrets = options.secrets ?? [];
    this.#runner = new ClaudeCodeSessionRunner(
      options.transport,
      this.#now,
      this.#secrets,
      this.#listeners,
    );
  }

  async probe(target: ExecutionTarget): Promise<CapabilityReport> {
    if (!target.available) return unsupported(target.reason ?? "target unavailable");
    if (target.kind !== "local" || target.platform !== process.platform) {
      return unsupported("Claude Code fake transport only runs on the local execution target");
    }
    return {
      support: "supported",
      constraints: {
        plane: "control",
        transport: this.#options.transport.kind,
        credentialsRequired: false,
        liveClaude: false,
      },
    };
  }

  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    return {
      text: CONTROL_SUPPORTED,
      tools: CONTROL_SUPPORTED,
      approvals: CONTROL_SUPPORTED,
      cancelTurn: CONTROL_SUPPORTED,
      history: CONTROL_SUPPORTED,
      resumeExecution: unsupported("Fake transport cannot resume a live Claude execution"),
      images: unsupported("Claude Code adapter does not accept image turns"),
      modelSwitch: unsupported("Claude Code adapter does not switch models during a turn"),
      detach: CONTROL_SUPPORTED,
      terminateSession: CONTROL_SUPPORTED,
      viewHistory: CONTROL_SUPPORTED,
      hostManagedModel: {
        support: "experimental",
        reason: "Host-managed model execution is not certified by ACP or the fake transport",
        constraints: { route: "harness-managed", acpProvesHostModel: false },
      },
    };
  }

  async harnessManagedSupport(): Promise<CapabilityReport> {
    return {
      support: "experimental",
      reason:
        "Control plane can run without Claude credentials. Global login is not read or overwritten, and this route does not reach the model execution layer.",
      constraints: { route: "harness-managed", touchesGlobalClaudeLogin: false },
    };
  }

  async hostManagedSupport(target: ExecutionTarget, selection: ModelSelection): Promise<CapabilityReport> {
    const report = await this.separatedReport(target, selection);
    return report.hostManagedModelChain.support;
  }

  /** Control readiness and the model chain are separate objects. */
  async separatedReport(
    target: ExecutionTarget,
    selection: ModelSelection,
  ): Promise<ClaudeCodeSeparatedReport> {
    const controlPlane = await this.probe(target);
    if (controlPlane.support !== "supported") {
      return {
        controlPlane,
        hostManagedModelChain: {
          plane: "model",
          route: "harness-managed",
          label: "experimental",
          reachedModelExecutionLayer: false,
          acpProvesHostModel: false,
          support: controlPlane,
        },
      };
    }
    const acpSessionOpen = this.#options.transport.kind === "acp" || this.#hasAcpSession();
    const inspection = await this.#port.inspect({
      scope: "selection-probe",
      requested: { kind: "host-managed", selection },
      acpSessionOpen,
      transportKind: this.#options.transport.kind,
    });
    return {
      controlPlane,
      hostManagedModelChain: reportClaudeCodeModelChain({
        requested: { kind: "host-managed", selection },
        inspection,
        acpSessionOpen,
        secrets: this.#secrets,
      }),
    };
  }

  async assessSessionModelChain(hostSessionId: string): Promise<ClaudeCodeModelChainReport> {
    const runtime = this.#require(hostSessionId);
    const acpSessionOpen = runtime.state.acpSessionOpen;
    const inspection = await this.#port.inspect({
      scope: "session",
      hostSessionId,
      workspaceIdentity: claudeCodeWorkspaceKey(runtime.spec),
      requested: runtime.spec.modelBinding,
      acpSessionOpen,
      transportKind: this.#options.transport.kind,
    });
    const model = reportClaudeCodeModelChain({
      requested: runtime.spec.modelBinding,
      inspection,
      acpSessionOpen,
      secrets: this.#secrets,
    });
    runtime.model = model;
    return model;
  }

  async create(spec: SessionSpec, _plan: BindingPlan): Promise<BackendBinding> {
    this.#assertIdentity(spec);
    if (this.#runtimes.has(spec.hostSessionId)) {
      throw new ClaudeCodeAdapterError("duplicate-id", "Claude Code host session already exists");
    }
    if (spec.modelBinding.kind === "host-managed") {
      const model = await this.#inspectSpec(spec);
      if (model.support.support !== "supported" || !model.reachedModelExecutionLayer) {
        throw new ClaudeCodeAdapterError(
          "unsupported",
          model.support.reason ?? "Host-managed Claude Code binding is not certified",
        );
      }
      return this.#open(spec, model);
    }
    const model = await this.harnessManagedSupport();
    return this.#open(spec, {
      plane: "model",
      route: "harness-managed",
      label: "experimental",
      reachedModelExecutionLayer: false,
      acpProvesHostModel: false,
      support: model,
    });
  }

  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    _lastJournalSequence: number,
    _plan: BindingPlan,
  ): Promise<void> {
    const runtime = this.#require(spec.hostSessionId);
    if (
      runtime.state.backendSessionId !== binding.backendSessionId ||
      runtime.state.runtimeEpoch !== binding.runtimeEpoch
    ) {
      throw new ClaudeCodeAdapterError("stale-epoch", "Stale Claude Code backend binding");
    }
  }

  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    await this.#runner.runTurn(this.#require(command.hostSessionId).state, command);
  }

  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    await this.#runner.cancel(this.#require(command.hostSessionId).state, command);
  }

  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    this.#runner.resolve(this.#require(command.hostSessionId).state, command);
  }

  async terminate(hostSessionId: string): Promise<void> {
    const runtime = this.#runtimes.get(hostSessionId);
    if (!runtime) return;
    runtime.state.closed = true;
    runtime.state.cancelRequested = true;
    runtime.state.pending?.resolve("deny");
    await this.#options.transport.close({
      hostSessionId,
      nativeSessionId: runtime.state.backendSessionId,
    });
    await this.#options.profileSink.removeProfile(runtime.state.configDir);
    this.#runtimes.delete(hostSessionId);
    logger.info(undefined, "claude-code session terminated", hostSessionId);
  }

  async shutdown(): Promise<void> {
    let next = this.#runtimes.keys().next();
    while (!next.done) {
      await this.terminate(next.value);
      next = this.#runtimes.keys().next();
    }
    await this.#options.transport.shutdown();
  }

  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    let listeners = this.#listeners.get(hostSessionId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(hostSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(hostSessionId);
    };
  }

  /** Recorded control events only. Does not prompt or call the model port. */
  readControlSnapshot(hostSessionId: string): readonly AgentEvent[] {
    return this.#require(hostSessionId).state.events.slice();
  }

  async #open(spec: SessionSpec, model: ClaudeCodeModelChainReport): Promise<BackendBinding> {
    const profile = planClaudeCodeProfile({
      managedRoot: this.#options.managedRoot,
      userHome: this.#options.userHome,
      spec,
      ...(this.#options.env ? { env: this.#options.env } : {}),
    });
    await this.#options.profileSink.writeMarker(profile.markerPath, profile.marker);
    let opened: Awaited<ReturnType<ClaudeCodeTransport["open"]>> | undefined;
    try {
      opened = await this.#options.transport.open({
        hostSessionId: spec.hostSessionId,
        workspaceKey: claudeCodeWorkspaceKey(spec),
        configDir: profile.configDir,
      });
      const binding = backendBindingSchema.parse({
        hostSessionId: spec.hostSessionId,
        backendSessionId: opened.nativeSessionId,
        backendVersion: this.version,
        runtimeEpoch: randomUUID(),
      });
      const state: ClaudeCodeSessionState = {
        bindingHostSessionId: spec.hostSessionId,
        runtimeEpoch: binding.runtimeEpoch,
        backendSessionId: binding.backendSessionId,
        workspaceKey: claudeCodeWorkspaceKey(spec),
        configDir: profile.configDir,
        acpSessionOpen: opened.acpSessionOpen,
        seq: 0,
        seenSourceIds: new Set(),
        events: [],
        cancelRequested: false,
        turnFinished: false,
        closed: false,
      };
      this.#runtimes.set(spec.hostSessionId, { spec, state, model });
      logger.info(undefined, "claude-code session created", spec.hostSessionId, opened.nativeSessionId);
      return binding;
    } catch (error) {
      if (opened) {
        await this.#options.transport.close({
          hostSessionId: spec.hostSessionId,
          nativeSessionId: opened.nativeSessionId,
        });
      }
      await this.#options.profileSink.removeProfile(profile.configDir);
      throw error;
    }
  }

  async #inspectSpec(spec: SessionSpec): Promise<ClaudeCodeModelChainReport> {
    if (spec.modelBinding.kind !== "host-managed") {
      throw new ClaudeCodeAdapterError("invalid-binding", "Expected a host-managed binding");
    }
    const acpSessionOpen = this.#options.transport.kind === "acp" || this.#hasAcpSession();
    const inspection = await this.#port.inspect({
      scope: "session",
      hostSessionId: spec.hostSessionId,
      workspaceIdentity: claudeCodeWorkspaceKey(spec),
      requested: spec.modelBinding,
      acpSessionOpen,
      transportKind: this.#options.transport.kind,
    });
    return reportClaudeCodeModelChain({
      requested: spec.modelBinding,
      inspection,
      acpSessionOpen,
      secrets: this.#secrets,
    });
  }

  #assertIdentity(spec: SessionSpec): void {
    if (spec.harness.id !== this.id || spec.harness.adapterVersion !== this.version) {
      throw new ClaudeCodeAdapterError("unknown-harness", "Claude Code harness identity does not match");
    }
  }

  #require(hostSessionId: string): ClaudeCodeRuntime {
    const runtime = this.#runtimes.get(hostSessionId);
    if (!runtime) throw new ClaudeCodeAdapterError("backend-failure", "Unknown Claude Code session");
    return runtime;
  }

  #hasAcpSession(): boolean {
    for (const runtime of this.#runtimes.values()) {
      if (runtime.state.acpSessionOpen) return true;
    }
    return false;
  }
}
