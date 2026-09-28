import { randomUUID } from "node:crypto";
import {
  agentEventSchema,
  backendBindingSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "./harnessRegistry.js";

interface PendingApproval {
  turnId: string;
  interactionId: string;
  settle(decision: "allow" | "deny"): void;
  answer: Promise<"allow" | "deny">;
}
interface MockState {
  binding: BackendBinding;
  seq: number;
  activeTurn?: string;
  pending?: PendingApproval;
  last?: AgentEvent;
  cancelled: boolean;
}
export interface MockScenario {
  textChunks?: readonly string[];
  failAfterText?: boolean;
  delayMs?: number;
  gapBeforeText?: boolean;
}

/** Deterministic, credential-free harness for admission, replay and projection tests. */
export class MockHarness implements HarnessAdapter {
  readonly id = "mock";
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly #states = new Map<string, MockState>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #scenario: MockScenario;

  constructor(scenario: MockScenario = {}) {
    this.#scenario = scenario;
  }
  async probe(target: ExecutionTarget) {
    return target.available
      ? { support: "supported" as const }
      : { support: "unsupported" as const, reason: "target unavailable" };
  }
  async hostManagedSupport(target: ExecutionTarget) {
    return this.probe(target);
  }
  async harnessManagedSupport(target: ExecutionTarget) {
    return this.probe(target);
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const yes = { support: "supported" as const };
    const no = { support: "unsupported" as const, reason: "not simulated" };
    return {
      text: yes,
      tools: yes,
      approvals: yes,
      cancelTurn: yes,
      resumeExecution: yes,
      history: yes,
      images: no,
      modelSwitch: no,
    };
  }
  async create(spec: SessionSpec): Promise<BackendBinding> {
    if (this.#states.has(spec.hostSessionId)) throw new Error("duplicate-id");
    const binding = backendBindingSchema.parse({
      hostSessionId: spec.hostSessionId,
      backendSessionId: `mock-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    });
    this.#states.set(spec.hostSessionId, { binding, seq: 0, cancelled: false });
    return binding;
  }
  async attach(spec: SessionSpec, binding: BackendBinding): Promise<void> {
    const state = this.#require(spec.hostSessionId);
    if (
      state.binding.backendSessionId !== binding.backendSessionId ||
      state.binding.runtimeEpoch !== binding.runtimeEpoch
    )
      throw new Error("stale-epoch");
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const state = this.#require(command.hostSessionId);
    if (state.activeTurn) throw new Error("session busy");
    state.activeTurn = command.turnId;
    state.cancelled = false;
    const base = { turnId: command.turnId };
    this.#emit(command.hostSessionId, "turn.started", base);
    if (this.#scenario.delayMs)
      await new Promise((resolve) => setTimeout(resolve, this.#scenario.delayMs));
    const text = this.#scenario.textChunks ?? ["Reading", " file"];
    if (this.#scenario.gapBeforeText) state.seq += 1;
    for (const chunk of text)
      this.#emit(command.hostSessionId, "text.delta", {
        ...base,
        messageId: `assistant-${command.turnId}`,
        text: chunk,
      });
    this.#emit(command.hostSessionId, "message.finished", {
      ...base,
      messageId: `assistant-${command.turnId}`,
      role: "assistant",
      text: text.join(""),
    });
    if (this.#scenario.failAfterText) {
      this.#emit(command.hostSessionId, "session.error", {
        code: "backend-failure",
        message: "mock crash",
      });
      this.#emit(command.hostSessionId, "turn.finished", { ...base, outcome: "failed" });
      state.activeTurn = undefined;
      return;
    }
    const tool = { ...base, toolCallId: "tool-1", name: "write" };
    this.#emit(command.hostSessionId, "tool.started", tool);
    let settle!: (decision: "allow" | "deny") => void;
    const answer = new Promise<"allow" | "deny">((resolve) => {
      settle = resolve;
    });
    state.pending = { turnId: command.turnId, interactionId: "approval-1", answer, settle };
    this.#emit(command.hostSessionId, "interaction.requested", {
      ...base,
      interactionId: "approval-1",
      toolCallId: tool.toolCallId,
      summary: "Write a file?",
    });
    const decision = await answer;
    state.pending = undefined;
    if (decision === "allow" && !state.cancelled) {
      this.#emit(command.hostSessionId, "tool.finished", {
        ...tool,
        outcome: "success",
        outputText: "simulated",
      });
    }
    this.#emit(command.hostSessionId, "turn.finished", {
      ...base,
      outcome: state.cancelled ? "cancelled" : "success",
    });
    state.activeTurn = undefined;
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    const state = this.#assertTurn(command);
    state.cancelled = true;
    state.pending?.settle("deny");
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const state = this.#assertTurn(command);
    const pending = state.pending;
    if (!pending || pending.interactionId !== command.interactionId)
      throw new Error("stale-interaction");
    state.pending = undefined;
    this.#emit(command.hostSessionId, "interaction.resolved", {
      turnId: command.turnId,
      interactionId: command.interactionId,
      decision: command.decision,
    });
    pending.settle(command.decision);
  }
  async terminate(hostSessionId: string): Promise<void> {
    const state = this.#require(hostSessionId);
    state.cancelled = true;
    state.pending?.settle("deny");
    this.#states.delete(hostSessionId);
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
  epoch(hostSessionId: string): string {
    return this.#require(hostSessionId).binding.runtimeEpoch;
  }
  async waitForInteraction(hostSessionId: string): Promise<void> {
    if (!this.#require(hostSessionId).pending) throw new Error("mock interaction has not started");
  }
  emitDuplicate(hostSessionId: string): void {
    const state = this.#require(hostSessionId);
    if (!state.last) throw new Error("no event");
    for (const listener of this.#listeners.get(hostSessionId) ?? []) listener(state.last);
  }
  #assertTurn(command: { hostSessionId: string; runtimeEpoch: string; turnId: string }): MockState {
    const state = this.#require(command.hostSessionId);
    if (state.binding.runtimeEpoch !== command.runtimeEpoch) throw new Error("stale-epoch");
    if (state.activeTurn !== command.turnId) throw new Error("stale-turn");
    return state;
  }
  #require(id: string): MockState {
    const state = this.#states.get(id);
    if (!state) throw new Error("unknown session");
    return state;
  }
  #emit(id: string, kind: AgentEvent["kind"], payload: Record<string, unknown>): void {
    const state = this.#require(id);
    const event = agentEventSchema.parse({
      hostSessionId: id,
      runtimeEpoch: state.binding.runtimeEpoch,
      sequence: ++state.seq,
      eventId: randomUUID(),
      at: Date.now(),
      kind,
      ...payload,
    });
    state.last = event;
    for (const listener of this.#listeners.get(id) ?? []) listener(event);
  }
}
