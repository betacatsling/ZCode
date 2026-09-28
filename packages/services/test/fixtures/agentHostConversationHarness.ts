import { randomUUID } from "node:crypto";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type BindingPlan,
  type ExecutionTarget,
  type HarnessCapabilities,
  type ModelSelection,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../src/agent-host/harnessRegistry.js";

interface FixtureState {
  binding: BackendBinding;
  sequence: number;
  activeTurn?: string;
  afterApproval?: {
    turnId: string;
    settle: (outcome: "success" | "cancelled") => void;
  };
  pending?: {
    interactionId: string;
    settle: (decision: "allow" | "deny" | "cancelled") => void;
  };
}

/** Credential-free adapter used by the UI data-layer integration test. */
export class AgentHostConversationFixtureHarness implements HarnessAdapter {
  readonly id = "conversation-fixture";
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly #states = new Map<string, FixtureState>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #holdNextAfterApproval = new Set<string>();

  async probe(target: ExecutionTarget) {
    return target.available
      ? { support: "supported" as const }
      : { support: "unsupported" as const, reason: "target unavailable" };
  }

  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const yes = { support: "supported" as const };
    return {
      text: yes,
      tools: yes,
      approvals: yes,
      cancelTurn: yes,
      resumeExecution: yes,
      history: yes,
      images: { support: "unsupported", reason: "fixture" },
      modelSwitch: { support: "unsupported", reason: "fixture" },
    };
  }

  async hostManagedSupport(target: ExecutionTarget, _selection: ModelSelection) {
    return this.probe(target);
  }

  async harnessManagedSupport(target: ExecutionTarget, _nativeModelId?: string) {
    return this.probe(target);
  }

  async create(spec: SessionSpec, _plan: BindingPlan): Promise<BackendBinding> {
    if (this.#states.has(spec.hostSessionId)) throw new Error("duplicate-id");
    const binding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `fixture-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    } satisfies BackendBinding;
    this.#states.set(spec.hostSessionId, { binding, sequence: 0 });
    return binding;
  }

  /** Seed completed user/assistant turns before a browser or store subscribes. */
  seedHistory(hostSessionId: string, turnCount: number): void {
    if (!Number.isSafeInteger(turnCount) || turnCount < 0)
      throw new Error("invalid fixture history");
    const state = this.#require(hostSessionId);
    if (state.sequence !== 0 || state.activeTurn)
      throw new Error("fixture history already started");
    for (let index = 0; index < turnCount; index += 1) {
      const turnId = `fixture-history-${hostSessionId}-${index}`;
      const turn = { turnId };
      this.#emit(hostSessionId, "turn.started", turn);
      this.#emit(hostSessionId, "message.finished", {
        ...turn,
        messageId: `fixture-history-user-${index}`,
        role: "user",
        text: `fixture-history-user-${index}`,
      });
      this.#emit(hostSessionId, "message.finished", {
        ...turn,
        messageId: `fixture-history-assistant-${index}`,
        role: "assistant",
        text: `fixture-history-assistant-${index}`,
      });
      this.#emit(hostSessionId, "turn.finished", { ...turn, outcome: "success" });
    }
  }

  holdNextAfterApproval(hostSessionId: string): void {
    this.#require(hostSessionId);
    this.#holdNextAfterApproval.add(hostSessionId);
  }

  async attach(spec: SessionSpec, binding: BackendBinding): Promise<void> {
    const state = this.#states.get(spec.hostSessionId);
    if (!state || state.binding.runtimeEpoch !== binding.runtimeEpoch)
      throw new Error("stale-epoch");
  }

  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const state = this.#require(command.hostSessionId);
    if (state.activeTurn) throw new Error("session busy");
    state.activeTurn = command.turnId;
    const turn = { turnId: command.turnId };
    this.#emit(command.hostSessionId, "turn.started", turn);
    this.#emit(command.hostSessionId, "message.finished", {
      ...turn,
      messageId: `user-${command.turnId}`,
      role: "user",
      text: command.text,
    });
    this.#emit(command.hostSessionId, "message.finished", {
      ...turn,
      messageId: `assistant-before-tool-${command.turnId}`,
      role: "assistant",
      text: "The Pi prepared the requested fixture write and is waiting for approval.",
    });
    this.#emit(command.hostSessionId, "tool.started", {
      ...turn,
      toolCallId: `tool-${command.turnId}`,
      name: "write",
      inputText: '{"path":"browser-proof.txt","content":"fixture write"}',
    });
    const interactionId = `approval-${command.turnId}`;
    const decision = await new Promise<"allow" | "deny" | "cancelled">((resolve) => {
      state.pending = { interactionId, settle: resolve };
      this.#emit(command.hostSessionId, "interaction.requested", {
        ...turn,
        interactionId,
        toolCallId: `tool-${command.turnId}`,
        summary: "Write fixture file?",
      });
    });
    state.pending = undefined;
    let outcome: "success" | "cancelled" = decision === "cancelled" ? "cancelled" : "success";
    if (decision === "allow") {
      this.#emit(command.hostSessionId, "tool.finished", {
        ...turn,
        toolCallId: `tool-${command.turnId}`,
        name: "write",
        outcome: "success",
        outputText: "AgentHost fixture write result: browser-proof.txt was written.",
      });
      this.#emit(command.hostSessionId, "message.finished", {
        ...turn,
        messageId: `assistant-after-tool-${command.turnId}`,
        role: "assistant",
        text: "The requested fixture file was written successfully.",
      });
      if (this.#holdNextAfterApproval.delete(command.hostSessionId)) {
        outcome = await new Promise<"success" | "cancelled">((resolve) => {
          state.afterApproval = { turnId: command.turnId, settle: resolve };
        });
        state.afterApproval = undefined;
      }
    }
    // 取消整轮时不先结束仍处于 pendingApproval 的工具；turn.finished 会原子清除审批并
    // 将未结算工具标为取消。提前发 tool.finished 会让投影误判成“审批未解决就完成工具”。
    this.#emit(command.hostSessionId, "turn.finished", {
      ...turn,
      outcome,
    });
    state.activeTurn = undefined;
  }

  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    const state = this.#require(command.hostSessionId);
    if (state.activeTurn !== command.turnId) throw new Error("stale-turn");
    if (state.pending) {
      state.pending.settle("cancelled");
      return;
    }
    if (state.afterApproval?.turnId === command.turnId) {
      state.afterApproval.settle("cancelled");
      return;
    }
    throw new Error("turn is not waiting on a fixture gate");
  }

  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const state = this.#require(command.hostSessionId);
    if (
      state.activeTurn !== command.turnId ||
      state.pending?.interactionId !== command.interactionId
    ) {
      throw new Error("stale-interaction");
    }
    this.#emit(command.hostSessionId, "interaction.resolved", {
      turnId: command.turnId,
      interactionId: command.interactionId,
      decision: command.decision,
    });
    state.pending.settle(command.decision);
  }

  async terminate(hostSessionId: string): Promise<void> {
    this.#states.delete(hostSessionId);
  }

  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(hostSessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(hostSessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(hostSessionId);
    };
  }

  #require(hostSessionId: string): FixtureState {
    const state = this.#states.get(hostSessionId);
    if (!state) throw new Error("unknown session");
    return state;
  }

  #emit(hostSessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>): void {
    const state = this.#require(hostSessionId);
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch: state.binding.runtimeEpoch,
      sequence: ++state.sequence,
      eventId: randomUUID(),
      at: state.sequence,
      kind,
      ...payload,
    });
    for (const listener of this.#listeners.get(hostSessionId) ?? []) listener(event);
  }
}
