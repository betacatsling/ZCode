import { randomUUID } from "node:crypto";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type BindingPlan,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter, PreparedHostBinding } from "../../agent-host/harnessRegistry.js";
import {
  devinHarnessCapabilities,
  devinHarnessManagedSupport,
  devinHostManagedSupport,
} from "./devinCapabilities.js";
import {
  DEVIN_ADAPTER_VERSION,
  probeDevinTarget,
  resolveDevinExecutable,
} from "./devinExecutable.js";
import { createDevinPrintEnvironment, DevinPrintSession } from "./devinPrintSession.js";

interface Runtime {
  binding: BackendBinding;
  cwd: string;
  seq: number;
  activeTurn?: string;
  activePrint?: DevinPrintSession;
  cancelled: boolean;
}

/** Local Devin CLI adapter: Wave 2 print-mode turns (`-p`), harness-managed models. */
export class DevinHarnessAdapter implements HarnessAdapter {
  readonly id = "devin";
  readonly version = DEVIN_ADAPTER_VERSION;
  readonly hostManagedRoute = "harness-managed" as const;
  readonly #root: string;
  readonly #executablePath?: string;
  readonly #sessions = new Map<string, Runtime>();
  readonly #subscriptions = new Map<string, Set<(event: AgentEvent) => void>>();
  #shuttingDown = false;

  constructor(options: { root: string; executablePath?: string }) {
    this.#root = options.root;
    this.#executablePath = options.executablePath;
    void this.#root;
  }

  async probe(target: ExecutionTarget) {
    return probeDevinTarget(target, this.#executablePath);
  }

  async hostManagedSupport(target: ExecutionTarget, selection: ModelSelection) {
    return devinHostManagedSupport({
      target,
      selection,
      ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
    });
  }

  async harnessManagedSupport(target: ExecutionTarget) {
    return devinHarnessManagedSupport({
      target,
      ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
    });
  }

  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    return devinHarnessCapabilities();
  }

  async create(
    spec: SessionSpec,
    _plan: BindingPlan,
    _prepared?: PreparedHostBinding,
  ): Promise<BackendBinding> {
    if (this.#shuttingDown) throw new Error("Devin target host is shutting down");
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("duplicate Devin session");
    await resolveDevinExecutable(this.#executablePath);
    const binding: BackendBinding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `devin-print-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    };
    this.#sessions.set(spec.hostSessionId, {
      binding,
      cwd: spec.execution.worktreePath,
      seq: 0,
      cancelled: false,
    });
    return binding;
  }

  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    _lastJournalSequence: number,
    _plan: BindingPlan,
    _prepared?: PreparedHostBinding,
  ): Promise<void> {
    if (this.#shuttingDown) throw new Error("Devin target host is shutting down");
    const current = this.#sessions.get(spec.hostSessionId);
    if (current) {
      if (
        current.binding.backendSessionId !== binding.backendSessionId ||
        current.binding.runtimeEpoch !== binding.runtimeEpoch
      ) {
        throw new Error("stale Devin backend binding");
      }
      return;
    }
    this.#sessions.set(spec.hostSessionId, {
      binding,
      cwd: spec.execution.worktreePath,
      seq: 0,
      cancelled: false,
    });
  }

  async send(
    command: Extract<AgentCommand, { type: "send" }>,
    _prepared?: PreparedHostBinding,
  ): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    // AgentCommand.send has no runtimeEpoch; Host already reserved the turn.
    if (runtime.activeTurn) throw new Error("Devin session busy");
    const text = command.text?.trim() ?? "";
    if (!text) throw new Error("Devin print mode requires non-empty user text");

    runtime.activeTurn = command.turnId;
    runtime.cancelled = false;
    this.#emit(command.hostSessionId, "turn.started", { turnId: command.turnId });

    const executable = await resolveDevinExecutable(this.#executablePath);
    const messageId = `assistant-${command.turnId}`;
    let assembled = "";
    const print = new DevinPrintSession({
      executablePath: executable,
      cwd: runtime.cwd,
      prompt: text,
      env: createDevinPrintEnvironment(executable),
      onStdoutChunk: (chunk) => {
        assembled += chunk;
        this.#emit(command.hostSessionId, "text.delta", {
          turnId: command.turnId,
          messageId,
          text: chunk,
        });
      },
    });
    runtime.activePrint = print;

    const result = await print.closed;
    runtime.activePrint = undefined;

    if (runtime.cancelled) {
      this.#emit(command.hostSessionId, "turn.finished", {
        turnId: command.turnId,
        outcome: "cancelled",
      });
      runtime.activeTurn = undefined;
      return;
    }

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || "Devin print mode exited non-zero").slice(
        0,
        1024,
      );
      this.#emit(command.hostSessionId, "session.error", {
        code: "devin-print-failed",
        message: detail,
      });
      this.#emit(command.hostSessionId, "turn.finished", {
        turnId: command.turnId,
        outcome: "failed",
      });
      runtime.activeTurn = undefined;
      return;
    }

    const finalText = assembled || result.stdout;
    this.#emit(command.hostSessionId, "message.finished", {
      turnId: command.turnId,
      messageId,
      role: "assistant",
      text: finalText,
    });
    this.#emit(command.hostSessionId, "turn.finished", {
      turnId: command.turnId,
      outcome: "success",
    });
    runtime.activeTurn = undefined;
  }

  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    if (runtime.binding.runtimeEpoch !== command.runtimeEpoch) throw new Error("stale-epoch");
    if (runtime.activeTurn !== command.turnId) throw new Error("stale-turn");
    runtime.cancelled = true;
    await runtime.activePrint?.cancel();
  }

  async resolveInteraction(
    _command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    throw new Error(
      "Devin print mode has no Host-mediated approvals; use ACP in a later wave for interaction events.",
    );
  }

  async terminate(hostSessionId: string): Promise<void> {
    const runtime = this.#sessions.get(hostSessionId);
    if (!runtime) return;
    runtime.cancelled = true;
    await runtime.activePrint?.cancel();
    this.#sessions.delete(hostSessionId);
    this.#subscriptions.delete(hostSessionId);
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    await Promise.all([...this.#sessions.keys()].map((id) => this.terminate(id)));
    this.#subscriptions.clear();
  }

  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const set = this.#subscriptions.get(hostSessionId) ?? new Set();
    set.add(listener);
    this.#subscriptions.set(hostSessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#subscriptions.delete(hostSessionId);
    };
  }

  #require(id: string): Runtime {
    const runtime = this.#sessions.get(id);
    if (!runtime) throw new Error("unknown Devin session");
    return runtime;
  }

  #emit(id: string, kind: AgentEvent["kind"], payload: Record<string, unknown>): void {
    const runtime = this.#require(id);
    const event = agentEventSchema.parse({
      hostSessionId: id,
      runtimeEpoch: runtime.binding.runtimeEpoch,
      sequence: ++runtime.seq,
      eventId: randomUUID(),
      at: Date.now(),
      kind,
      ...payload,
    });
    for (const listener of this.#subscriptions.get(id) ?? []) listener(event);
  }
}
