import { randomUUID } from "node:crypto";
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
import { acpHarnessCapabilities, acpProbeReport } from "./acpCapabilities.js";
import { ACP_ADAPTER_VERSION, ACP_SESSION_MACHINE_ID, type AcpNegotiation } from "./acpProtocol.js";
import type { AcpAgentProfile } from "./acpProfile.js";
import { AcpSessionMachine } from "./acpSessionMachine.js";
import type { AcpTransport } from "./acpTransport.js";

const logger = createServiceLogger("agent-adapters/acp");

export interface AcpHarnessOptions {
  readonly profile: AcpAgentProfile;
  readonly openTransport: (connectionId: string) => AcpTransport;
  readonly now?: () => number;
}

/** 同一个状态机服务所有 ACP 档案。档案差异只留在 manifest 和安装提示。 */
export class AcpHarnessAdapter implements HarnessAdapter {
  readonly id: string;
  readonly version = ACP_ADAPTER_VERSION;
  readonly hostManagedRoute = "harness-managed" as const;
  readonly sessionMachineId = ACP_SESSION_MACHINE_ID;
  readonly #profile: AcpAgentProfile;
  readonly #openTransport: AcpHarnessOptions["openTransport"];
  readonly #now: () => number;
  readonly #sessions = new Map<string, AcpSessionMachine>();
  readonly #retainedHistory = new Map<string, readonly AgentEvent[]>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #probes = new Map<string, AcpNegotiation>();

  constructor(options: AcpHarnessOptions) {
    if (options.profile.manifest.adapterVersion !== ACP_ADAPTER_VERSION) {
      throw new Error("ACP profile adapterVersion does not match the shared session machine");
    }
    this.id = options.profile.manifest.id;
    this.#profile = options.profile;
    this.#openTransport = options.openTransport;
    this.#now = options.now ?? Date.now;
  }

  async probe(target: ExecutionTarget): Promise<CapabilityReport> {
    if (!target.available) return { support: "unsupported", reason: target.reason ?? "target unavailable" };
    const machine = this.#connect(`probe:${target.id}`, target.id);
    try {
      const negotiation = await machine.initialize();
      this.#probes.set(target.id, negotiation);
      this.#logNegotiation(negotiation);
      return acpProbeReport(negotiation);
    } finally {
      await machine.close();
    }
  }

  async capabilities(target: ExecutionTarget): Promise<HarnessCapabilities> {
    return acpHarnessCapabilities(await this.#negotiation(target));
  }

  async hostManagedSupport(): Promise<CapabilityReport> {
    return {
      support: "unsupported",
      reason: "ACP long-tail agents are not certified for host-managed model injection",
    };
  }

  async harnessManagedSupport(target: ExecutionTarget): Promise<CapabilityReport> {
    const negotiation = this.#probes.get(target.id);
    if (!negotiation) return { support: "unknown", reason: "ACP initialize has not run for this target" };
    return acpProbeReport(negotiation);
  }

  async create(spec: SessionSpec, plan: BindingPlan): Promise<BackendBinding> {
    this.#assertPlan(spec, plan);
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("duplicate-id");
    const machine = this.#connect(spec.hostSessionId, spec.execution.worktreePath);
    try {
      const negotiation = await machine.initialize();
      this.#logNegotiation(negotiation);
      const backendSessionId = await machine.openNewSession();
      const runtimeEpoch = randomUUID();
      machine.bindRuntime(runtimeEpoch, 0);
      const binding = backendBindingSchema.parse({
        hostSessionId: spec.hostSessionId,
        backendSessionId,
        backendVersion: this.version,
        runtimeEpoch,
      });
      this.#sessions.set(spec.hostSessionId, machine);
      return binding;
    } catch (error) {
      await machine.close();
      throw error;
    }
  }

  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    lastJournalSequence: number,
    plan: BindingPlan,
  ): Promise<void> {
    this.#assertPlan(spec, plan);
    if (binding.hostSessionId !== spec.hostSessionId || binding.backendVersion !== this.version) {
      throw new Error("backend identity mismatch");
    }
    const current = this.#sessions.get(spec.hostSessionId);
    if (current?.backendSessionId() === binding.backendSessionId) return;
    const machine = this.#connect(spec.hostSessionId, spec.execution.worktreePath);
    try {
      const negotiation = await machine.initialize();
      this.#logNegotiation(negotiation);
      if (negotiation.stability !== "stable" || (!negotiation.loadSession && !negotiation.resumeSession)) {
        throw new Error(
          negotiation.stability === "stable"
            ? "unsupported: ACP session resume was not negotiated"
            : `experimental: ${negotiation.stabilityReason ?? "ACP protocol version is not stable"}`,
        );
      }
      machine.bindRuntime(binding.runtimeEpoch, lastJournalSequence);
      await machine.resumeNative(binding.backendSessionId);
      this.#sessions.set(spec.hostSessionId, machine);
    } catch (error) {
      await machine.close();
      throw error;
    }
  }

  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    await this.#require(command.hostSessionId).prompt(command.turnId, command.text);
  }

  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    await this.#require(command.hostSessionId).cancelTurn(command.turnId, command.runtimeEpoch);
  }

  async resolveInteraction(command: Extract<AgentCommand, { type: "resolveInteraction" }>): Promise<void> {
    await this.#require(command.hostSessionId).resolveInteraction(command);
  }

  async terminate(hostSessionId: string): Promise<void> {
    const machine = this.#sessions.get(hostSessionId);
    if (!machine) return;
    this.#retainedHistory.set(hostSessionId, machine.history());
    this.#sessions.delete(hostSessionId);
    await machine.close();
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((machine) => machine.close()));
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
      if (listeners.size === 0) this.#listeners.delete(hostSessionId);
    };
  }

  viewHistory(hostSessionId: string): readonly AgentEvent[] {
    return this.#sessions.get(hostSessionId)?.history() ?? this.#retainedHistory.get(hostSessionId) ?? [];
  }

  resumeExecution(
    hostSessionId: string,
    backendSessionId: string,
  ): Promise<{ method: "session/load" | "session/resume"; replaysHistory: boolean }> {
    return this.#require(hostSessionId).resumeNative(backendSessionId);
  }

  #connect(hostSessionId: string, cwd: string): AcpSessionMachine {
    return new AcpSessionMachine({
      hostSessionId,
      cwd,
      transport: this.#openTransport(hostSessionId),
      now: this.#now,
      onEvent: (event) => {
        for (const listener of this.#listeners.get(event.hostSessionId) ?? []) listener(event);
      },
    });
  }

  async #negotiation(target: ExecutionTarget): Promise<AcpNegotiation | undefined> {
    const cached = this.#probes.get(target.id);
    if (cached) return cached;
    await this.probe(target);
    return this.#probes.get(target.id);
  }

  #assertPlan(spec: SessionSpec, plan: BindingPlan): void {
    if (spec.harness.id !== this.id || spec.harness.adapterVersion !== this.version) {
      throw new Error("harness identity or adapter version mismatch");
    }
    if (plan.harnessId !== this.id || plan.adapterVersion !== this.version || plan.route !== "harness-managed") {
      throw new Error("unsupported: ACP adapter only admits harness-managed bindings");
    }
    if (spec.modelBinding.kind !== "harness-managed") {
      throw new Error("unsupported: host-managed model injection is not certified");
    }
  }

  #require(hostSessionId: string): AcpSessionMachine {
    const machine = this.#sessions.get(hostSessionId);
    if (!machine) throw new Error("unknown session");
    return machine;
  }

  #logNegotiation(negotiation: AcpNegotiation): void {
    logger.info(undefined, "acp.initialize", {
      harnessId: this.#profile.manifest.id,
      protocolVersion: negotiation.protocolVersion,
      stability: negotiation.stability,
      authMethodIds: negotiation.authMethods.map((method) => method.methodId),
      loadSession: negotiation.loadSession,
      resumeSession: negotiation.resumeSession,
    });
  }
}

export function createAcpHarness(options: AcpHarnessOptions): AcpHarnessAdapter {
  return new AcpHarnessAdapter(options);
}
