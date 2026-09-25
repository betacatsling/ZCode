import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  AgentCommand,
  AgentEvent,
  BackendBindingV2,
  BindingPlan,
  CapabilityReport,
  ExecutionTarget,
  HarnessCapabilitiesV2,
  SessionSpecV2,
} from "@zcode/shared/agent-host";
import { writableSessionSpecV2Schema, backendBindingV2Schema } from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../agent-host/harnessRegistry.js";
import {
  AcpTransport,
  type AcpDescriptor,
  type AcpPermission,
  type AcpTransportOptions,
} from "./acpTransport.js";
import { projectAcpUpdate, type AcpTurnProjection } from "./acpProjection.js";
import { probeTrustedAcpProfile } from "./acpProbe.js";
import { isPinnedClaudeAcpDescriptor } from "./pinnedClaudeProfile.js";
const supported = { support: "supported" } as const;
const unsupported = (reason: string): CapabilityReport => ({ support: "unsupported", reason });

export interface TrustedAcpProfile {
  id: string;
  version: string;
  /** Set only after native prompt/tool/approval certification of this exact pinned profile. */
  certified?: boolean;
  /** Trusted target service, not a renderer path or a path-only realpath check. */
  verifyCwd(spec: SessionSpecV2): Promise<string>;
  targetFor(spec: SessionSpecV2): ExecutionTarget;
  /** Trusted probe directory/profile; no session creation or agent launch. */
  probeDescriptor(target: ExecutionTarget): AcpDescriptor;
  /** Trusted packaged configuration only; never read scripts or executable names from the worktree. */
  descriptor(target: ExecutionTarget, canonicalCwd: string, hostSessionId: string): AcpDescriptor;
  transport?: Pick<
    AcpTransportOptions,
    "probeVersion" | "launch" | "clientRequests" | "clientCapabilities"
  >;
}

interface Runtime {
  transport: AcpTransport;
  binding: BackendBindingV2;
  sequence: number;
  turn?: AcpTurnProjection;
  permissions: Map<string, { turnId: string; request: AcpPermission; allowOption?: string }>;
  failed?: Error;
}

/** One ACP subprocess per session; Host remains the only durable admission and event owner. */
export class AcpHarnessAdapter implements HarnessAdapter {
  readonly id: string;
  readonly version: string;
  readonly hostManagedRoute = undefined;
  readonly #sessions = new Map<string, Runtime>();
  readonly #subscribers = new Map<string, Set<(event: AgentEvent) => void>>();
  constructor(private readonly profile: TrustedAcpProfile) {
    if (!/^[a-z][a-z0-9-]*$/.test(profile.id) || !profile.version)
      throw new Error("invalid trusted ACP profile");
    this.id = profile.id;
    this.version = profile.version;
  }
  async probe(target: ExecutionTarget): Promise<CapabilityReport> {
    return probeTrustedAcpProfile(this.profile, target);
  }
  async capabilities(target: ExecutionTarget): Promise<HarnessCapabilitiesV2> {
    const report = await this.probe(target);
    const no = unsupported("ACP optional operation not certified for this target/profile");
    return {
      text: report,
      tools: report,
      approvals: report,
      cancelTurn: report,
      resumeExecution: unsupported("ACP loadSession must be negotiated on this native process"),
      history: supported,
      images: no,
      modelSwitch: no,
      detach: supported,
      terminateSession: report,
      viewHistory: supported,
      hostManagedModel: unsupported("ACP is harness-managed; no ZCode model injection"),
      fork: no,
      subagents: no,
    };
  }
  async hostManagedSupport(
    _target: ExecutionTarget,
    _selection: ModelSelection,
  ): Promise<CapabilityReport> {
    return unsupported("ACP is harness-managed; no ZCode model injection");
  }
  async harnessManagedSupport(target: ExecutionTarget): Promise<CapabilityReport> {
    return this.probe(target);
  }
  async create(spec: SessionSpecV2, plan: BindingPlan): Promise<BackendBindingV2> {
    this.#check(spec, plan);
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("ACP session already attached");
    const transport = await this.#connect(spec);
    try {
      const backendSessionId = await transport.newSession();
      const binding = backendBindingV2Schema.parse({
        schemaVersion: 2,
        hostSessionId: spec.hostSessionId,
        backendSessionId,
        backendVersion: this.version,
        runtimeEpoch: randomUUID(),
        targetId: spec.execution.targetId,
        workspaceId: spec.workspaceId,
        worktreeGeneration: spec.execution.worktreeGeneration,
        harnessId: this.id,
      });
      this.#mount(binding, transport, 0);
      return binding;
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
  async attach(
    spec: SessionSpecV2,
    raw: BackendBindingV2,
    lastJournalSequence: number,
    plan: BindingPlan,
  ): Promise<void> {
    this.#check(spec, plan);
    const binding = backendBindingV2Schema.parse(raw);
    if (
      binding.hostSessionId !== spec.hostSessionId ||
      binding.targetId !== spec.execution.targetId ||
      binding.workspaceId !== spec.workspaceId ||
      binding.worktreeGeneration !== spec.execution.worktreeGeneration ||
      binding.harnessId !== this.id ||
      binding.backendVersion !== this.version ||
      !Number.isSafeInteger(lastJournalSequence) ||
      lastJournalSequence < 0
    )
      throw new Error("stale ACP binding");
    if (this.#sessions.has(spec.hostSessionId)) {
      if (this.#sessions.get(spec.hostSessionId)?.binding.runtimeEpoch !== binding.runtimeEpoch)
        throw new Error("stale ACP epoch");
      return;
    }
    const transport = await this.#connect(spec);
    try {
      if (!transport.capabilities.loadSession)
        throw new Error("ACP history-only: session/load not negotiated");
      await transport.load(binding.backendSessionId);
      this.#mount(binding, transport, lastJournalSequence);
    } catch (error) {
      await transport.close();
      throw error;
    }
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    if (runtime.turn || runtime.failed) throw new Error("ACP busy or execution unknown");
    const turn: AcpTurnProjection = {
      id: command.turnId,
      messageId: `${command.turnId}:assistant`,
      text: "",
      cancelled: false,
      tools: new Map(),
      finishedTools: new Set(),
    };
    runtime.turn = turn;
    this.#emit(command.hostSessionId, runtime, { kind: "turn.started", turnId: turn.id });
    this.#emit(command.hostSessionId, runtime, { kind: "session.status", state: "running" });
    try {
      const result = await runtime.transport.prompt(command.text);
      if (runtime.turn !== turn) return;
      if (turn.cancelled && result.stopReason === "cancelled") {
        // 原生终态已确认取消，但无 prompt ID 的迟到 update 仍可能污染下一轮：封闭连接。
        runtime.failed = new Error("ACP cancelled connection requires verified recovery");
        this.#finish(command.hostSessionId, runtime, turn, "cancelled");
      } else if (!turn.cancelled && result.stopReason === "end_turn") {
        this.#finish(command.hostSessionId, runtime, turn, "success");
      } else {
        throw new Error("ACP prompt outcome unknown");
      }
    } catch (error) {
      if (runtime.turn === turn) {
        runtime.failed = error instanceof Error ? error : new Error("ACP prompt outcome unknown");
        for (const pending of runtime.permissions.values()) pending.request.deny();
        runtime.permissions.clear();
        this.#emit(command.hostSessionId, runtime, {
          kind: "session.status",
          state: "execution-unknown",
        });
      }
      throw error;
    }
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    const turn = runtime.turn;
    if (
      !turn ||
      turn.id !== command.turnId ||
      runtime.binding.runtimeEpoch !== command.runtimeEpoch
    )
      throw new Error("stale ACP cancel");
    turn.cancelled = true;
    await runtime.transport.cancel();
    // Do not release the turn for another prompt until ACP acknowledges the old prompt.
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    const pending = runtime.permissions.get(command.interactionId);
    if (
      !pending ||
      !runtime.turn ||
      runtime.turn.cancelled ||
      pending.turnId !== command.turnId ||
      runtime.turn.id !== command.turnId ||
      command.runtimeEpoch !== runtime.binding.runtimeEpoch
    )
      throw new Error("stale ACP interaction");
    if (command.decision === "allow" && !pending.allowOption)
      throw new Error("ACP one-shot approval option unavailable");
    const ok =
      command.decision === "allow"
        ? pending.request.resolve(pending.allowOption!)
        : pending.request.deny();
    if (!ok) throw new Error("ACP permission already settled");
    runtime.permissions.delete(command.interactionId);
    this.#emit(command.hostSessionId, runtime, {
      kind: "interaction.resolved",
      turnId: command.turnId,
      interactionId: command.interactionId,
      decision: command.decision,
    });
  }
  async terminate(hostSessionId: string): Promise<void> {
    const runtime = this.#require(hostSessionId);
    this.#sessions.delete(hostSessionId);
    await runtime.transport.close();
  }
  async shutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((runtime) => runtime.transport.close()));
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    let listeners = this.#subscribers.get(hostSessionId);
    if (!listeners) {
      listeners = new Set();
      this.#subscribers.set(hostSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.#subscribers.delete(hostSessionId);
    };
  }
  #check(spec: SessionSpecV2, plan: BindingPlan): void {
    writableSessionSpecV2Schema.parse(spec);
    if (
      spec.harness.id !== this.id ||
      spec.harness.adapterVersion !== this.version ||
      spec.modelBinding.kind !== "harness-managed" ||
      plan.requested.kind !== "harness-managed" ||
      plan.route !== "harness-managed" ||
      plan.support.support !== "supported" ||
      plan.effective ||
      plan.hostSessionId !== spec.hostSessionId ||
      plan.targetId !== spec.execution.targetId ||
      plan.harnessId !== this.id ||
      plan.adapterVersion !== this.version ||
      JSON.stringify(plan.requested) !== JSON.stringify(spec.modelBinding)
    )
      throw new Error("ACP requires certified harness-managed binding and matching identity");
  }
  async #connect(spec: SessionSpecV2): Promise<AcpTransport> {
    const canonicalCwd = await this.profile.verifyCwd(spec);
    if (!isAbsolute(canonicalCwd)) throw new Error("ACP unverified canonical cwd");
    const target = this.profile.targetFor(spec);
    if (target.id !== spec.execution.targetId || !target.available)
      throw new Error("ACP target unavailable or identity mismatch");
    const descriptor = this.profile.descriptor(target, canonicalCwd, spec.hostSessionId);
    if (
      descriptor.cwd !== canonicalCwd ||
      !isAbsolute(descriptor.executable) ||
      descriptor.version.exact !== this.version ||
      !isAbsolute(descriptor.env.HOME ?? "")
    )
      throw new Error("ACP trusted descriptor cwd/executable/profile/version mismatch");
    // 原生设置管理器在 canUseTool 之前读取工作树规则；未隔离时禁止绕过 probe 注入 supported plan。
    if (isPinnedClaudeAcpDescriptor(descriptor))
      throw new Error(
        "ACP pinned Claude profile uncertified: project settings can bypass approval",
      );
    const id = spec.hostSessionId;
    return AcpTransport.connect(descriptor, {
      ...this.profile.transport,
      onPermission: (request) => this.#permission(id, request),
    });
  }
  #mount(binding: BackendBindingV2, transport: AcpTransport, sequence: number): void {
    const runtime: Runtime = { binding, transport, sequence, permissions: new Map() };
    this.#sessions.set(binding.hostSessionId, runtime);
    transport.onUpdate((params) => {
      if (
        this.#sessions.get(binding.hostSessionId) !== runtime ||
        !runtime.turn ||
        runtime.turn.cancelled ||
        runtime.failed
      )
        return;
      projectAcpUpdate(params.update, runtime.turn, (fields) =>
        this.#emit(binding.hostSessionId, runtime, fields),
      );
    });
    transport.onExit((error) => {
      if (this.#sessions.get(binding.hostSessionId) !== runtime) return;
      runtime.failed = error;
      if (runtime.turn) this.#finish(binding.hostSessionId, runtime, runtime.turn, "unknown");
      this.#emit(binding.hostSessionId, runtime, {
        kind: "session.status",
        state: "execution-unknown",
      });
    });
  }
  #require(id: string): Runtime {
    const runtime = this.#sessions.get(id);
    if (!runtime) throw new Error("ACP backend not attached");
    return runtime;
  }
  #emit(id: string, runtime: Runtime, fields: Record<string, unknown>): void {
    const event = {
      hostSessionId: id,
      runtimeEpoch: runtime.binding.runtimeEpoch,
      sequence: ++runtime.sequence,
      eventId: randomUUID(),
      at: Date.now(),
      ...fields,
    } as AgentEvent;
    for (const listener of this.#subscribers.get(id) ?? []) listener(event);
  }
  #finish(
    id: string,
    runtime: Runtime,
    turn: AcpTurnProjection,
    outcome: "success" | "cancelled" | "unknown",
  ): void {
    for (const pending of runtime.permissions.values()) pending.request.deny();
    runtime.permissions.clear();
    if (turn.text)
      this.#emit(id, runtime, {
        kind: "message.finished",
        turnId: turn.id,
        messageId: turn.messageId,
        text: turn.text,
        role: "assistant",
      });
    this.#emit(id, runtime, { kind: "turn.finished", turnId: turn.id, outcome });
    this.#emit(id, runtime, {
      kind: "session.status",
      state: outcome === "success" ? "idle" : "execution-unknown",
    });
    runtime.turn = undefined;
  }
  #permission(id: string, request: AcpPermission): void {
    const runtime = this.#sessions.get(id);
    const turn = runtime?.turn;
    if (!runtime || !turn || turn.cancelled || runtime.failed) {
      request.deny();
      return;
    }
    const interactionId = String(request.id);
    if (runtime.permissions.has(interactionId)) {
      request.deny();
      return;
    }
    // ACP allow_always would authorize later effects without a new Host admission; never select it.
    const allow = request.options.find((o) => o.kind === "allow_once");
    runtime.permissions.set(interactionId, {
      turnId: turn.id,
      request,
      allowOption: typeof allow?.optionId === "string" ? allow.optionId : undefined,
    });
    this.#emit(id, runtime, {
      kind: "interaction.requested",
      turnId: turn.id,
      interactionId,
      toolCallId: String(request.toolCall.toolCallId),
      summary: String(request.toolCall.title ?? "ACP tool approval"),
    });
  }
}
