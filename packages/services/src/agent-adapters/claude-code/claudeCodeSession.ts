import { randomUUID } from "node:crypto";
import { agentEventSchema, type AgentCommand, type AgentEvent } from "@zcode/shared/agent-host";
import { ClaudeCodeAdapterError } from "./claudeCodeErrors.js";
import {
  redactClaudeCodeValue,
  translateClaudeCodeNativeEvent,
  type ClaudeCodeNativeEvent,
  type ClaudeCodeTranslatedEvent,
} from "./claudeCodeNative.js";
import type { ClaudeCodeTransport } from "./claudeCodeFakeTransport.js";

interface PendingInteraction {
  readonly turnId: string;
  readonly interactionId: string;
  readonly resolve: (decision: "allow" | "deny") => void;
}

export interface ClaudeCodeSessionState {
  readonly bindingHostSessionId: string;
  readonly runtimeEpoch: string;
  readonly backendSessionId: string;
  readonly workspaceKey: string;
  readonly configDir: string;
  readonly acpSessionOpen: boolean;
  seq: number;
  readonly seenSourceIds: Set<string>;
  readonly events: AgentEvent[];
  activeTurnId?: string;
  cancelRequested: boolean;
  turnFinished: boolean;
  pending?: PendingInteraction;
  closed: boolean;
}

export class ClaudeCodeSessionRunner {
  constructor(
    private readonly transport: ClaudeCodeTransport,
    private readonly now: () => number,
    private readonly secrets: readonly string[],
    private readonly listeners: Map<string, Set<(event: AgentEvent) => void>>,
  ) {}

  async runTurn(
    session: ClaudeCodeSessionState,
    command: Extract<AgentCommand, { type: "send" }>,
  ): Promise<void> {
    if (session.closed)
      throw new ClaudeCodeAdapterError("backend-failure", "Claude Code session is closed");
    if (session.activeTurnId) {
      throw new ClaudeCodeAdapterError("backend-failure", "Concurrent Claude Code turn rejected");
    }
    session.activeTurnId = command.turnId;
    session.cancelRequested = false;
    session.turnFinished = false;
    this.#emit(session, { kind: "turn.started", turnId: command.turnId });
    const iterator = this.transport
      .prompt({
        hostSessionId: session.bindingHostSessionId,
        nativeSessionId: session.backendSessionId,
        turnId: command.turnId,
        text: command.text,
      })
      [Symbol.asyncIterator]();
    try {
      while (!session.cancelRequested) {
        const next = await iterator.next();
        if (next.done) break;
        const step = await this.#consume(session, command.turnId, next.value);
        if (step === "stop") break;
      }
      if (session.cancelRequested) {
        await this.transport.cancel({
          hostSessionId: session.bindingHostSessionId,
          nativeSessionId: session.backendSessionId,
          turnId: command.turnId,
        });
        this.#closePending(session, command.turnId, "deny");
        if (!session.turnFinished) {
          this.#emit(session, {
            kind: "turn.finished",
            turnId: command.turnId,
            outcome: "cancelled",
          });
          session.turnFinished = true;
        }
      } else if (!session.turnFinished) {
        this.#emit(session, { kind: "turn.finished", turnId: command.turnId, outcome: "unknown" });
        session.turnFinished = true;
      }
    } finally {
      session.activeTurnId = undefined;
      session.pending = undefined;
      await iterator.return?.();
    }
  }

  async cancel(
    session: ClaudeCodeSessionState,
    command: Extract<AgentCommand, { type: "cancelTurn" }>,
  ): Promise<void> {
    this.#assertLiveTurn(session, command.runtimeEpoch, command.turnId);
    session.cancelRequested = true;
    this.#closePending(session, command.turnId, "deny");
    await this.transport.cancel({
      hostSessionId: session.bindingHostSessionId,
      nativeSessionId: session.backendSessionId,
      turnId: command.turnId,
    });
  }

  resolve(
    session: ClaudeCodeSessionState,
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): void {
    this.#assertLiveTurn(session, command.runtimeEpoch, command.turnId);
    const pending = session.pending;
    if (!pending || pending.interactionId !== command.interactionId) {
      throw new ClaudeCodeAdapterError("stale-interaction", "Claude Code interaction is stale");
    }
    session.pending = undefined;
    this.#emit(session, {
      kind: "interaction.resolved",
      turnId: command.turnId,
      interactionId: command.interactionId,
      decision: command.decision,
    });
    pending.resolve(command.decision);
  }

  #assertLiveTurn(session: ClaudeCodeSessionState, runtimeEpoch: string, turnId: string): void {
    if (session.runtimeEpoch !== runtimeEpoch) {
      throw new ClaudeCodeAdapterError("stale-epoch", "Claude Code runtime epoch is stale");
    }
    if (session.activeTurnId !== turnId) {
      throw new ClaudeCodeAdapterError("stale-turn", "Claude Code turn is stale");
    }
  }

  #closePending(session: ClaudeCodeSessionState, turnId: string, decision: "allow" | "deny"): void {
    const pending = session.pending;
    if (!pending || pending.turnId !== turnId) return;
    session.pending = undefined;
    this.#emit(session, {
      kind: "interaction.resolved",
      turnId,
      interactionId: pending.interactionId,
      decision,
    });
    pending.resolve(decision);
  }

  async #consume(
    session: ClaudeCodeSessionState,
    turnId: string,
    event: ClaudeCodeNativeEvent,
  ): Promise<"continue" | "stop"> {
    if (session.seenSourceIds.has(event.sourceEventId)) return "continue";
    session.seenSourceIds.add(event.sourceEventId);
    const translated = translateClaudeCodeNativeEvent(event);
    if (translated === "gap") {
      this.#emit(session, {
        kind: "session.error",
        code: "execution-unknown",
        message: "Claude Code event sequence gap; refusing to invent missing events",
      });
      this.#emit(session, { kind: "turn.finished", turnId, outcome: "unknown" });
      session.turnFinished = true;
      return "stop";
    }
    this.#emit(session, translated);
    if (event.kind === "turn.finished") {
      session.turnFinished = true;
      return "stop";
    }
    if (event.kind === "interaction.requested") {
      const decision = await this.#waitDecision(session, turnId, event.interactionId);
      if (decision === "deny" || session.cancelRequested) {
        if (!session.turnFinished) {
          this.#emit(session, { kind: "turn.finished", turnId, outcome: "cancelled" });
          session.turnFinished = true;
        }
        return "stop";
      }
    }
    return "continue";
  }

  #waitDecision(
    session: ClaudeCodeSessionState,
    turnId: string,
    interactionId: string,
  ): Promise<"allow" | "deny"> {
    return new Promise((resolve) => {
      session.pending = { turnId, interactionId, resolve };
    });
  }

  #emit(session: ClaudeCodeSessionState, event: ClaudeCodeTranslatedEvent): void {
    const parsed = agentEventSchema.parse(
      redactClaudeCodeValue(
        {
          hostSessionId: session.bindingHostSessionId,
          runtimeEpoch: session.runtimeEpoch,
          sequence: session.seq + 1,
          eventId: randomUUID(),
          at: this.now(),
          ...event,
        },
        this.secrets,
      ),
    );
    session.seq = parsed.sequence;
    session.events.push(parsed);
    for (const listener of this.listeners.get(session.bindingHostSessionId) ?? []) listener(parsed);
  }
}
