import { agentEventSchema, type AgentEvent } from "@zcode/shared/agent-host";
import type { PiPeerFrame } from "./piControlProtocol.js";
import type { PiRpcSession } from "./piRpcSession.js";

const CERTIFIED_TOOLS = new Set(["read", "write", "exec"]);

export interface PendingApproval {
  readonly turnId: string;
  readonly interactionId: string;
  readonly name: string;
  readonly summary: string;
}

/** Projects Pi frames into the host event log. It does not admit commands. */
export class PiPeerProjector {
  readonly #rpc: PiRpcSession;
  readonly #hostSessionId: string;
  readonly #runtimeEpoch: string;
  readonly #now: () => number;
  readonly #ids: () => string;
  readonly #onTurnFinished: () => void;
  readonly #events: AgentEvent[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #sources = new Set<string>();
  readonly #startedTools = new Set<string>();
  #sequence = 0;
  #activeTurn?: string;
  #pending?: PendingApproval;

  constructor(options: {
    rpc: PiRpcSession;
    hostSessionId: string;
    runtimeEpoch: string;
    now: () => number;
    ids: () => string;
    onTurnFinished: () => void;
  }) {
    this.#rpc = options.rpc;
    this.#hostSessionId = options.hostSessionId;
    this.#runtimeEpoch = options.runtimeEpoch;
    this.#now = options.now;
    this.#ids = options.ids;
    this.#onTurnFinished = options.onTurnFinished;
  }

  get activeTurn(): string | undefined {
    return this.#activeTurn;
  }

  get pending(): PendingApproval | undefined {
    return this.#pending;
  }

  setActiveTurn(turnId: string | undefined): void {
    this.#activeTurn = turnId;
  }

  clearPending(): void {
    this.#pending = undefined;
  }

  events(): readonly AgentEvent[] {
    return this.#events;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clearListeners(): void {
    this.#listeners.clear();
  }

  markStarted(interactionId: string): void {
    this.#startedTools.add(interactionId);
  }

  handle(frame: PiPeerFrame): void {
    if ("sourceEventId" in frame) {
      if (this.#sources.has(frame.sourceEventId)) return;
      this.#sources.add(frame.sourceEventId);
    }
    if (frame.type === "text.delta") {
      if (frame.turnId !== this.#activeTurn) return;
      this.emit({
        kind: "text.delta",
        turnId: frame.turnId,
        messageId: frame.messageId,
        text: frame.text,
        sourceEventId: frame.sourceEventId,
      });
      return;
    }
    if (frame.type === "message.snapshot") {
      if (frame.turnId !== this.#activeTurn) return;
      this.emit({
        kind: "message.finished",
        turnId: frame.turnId,
        messageId: frame.messageId,
        role: frame.role,
        text: frame.text,
        sourceEventId: frame.sourceEventId,
      });
      return;
    }
    if (frame.type === "tool.pending") {
      this.#holdTool(frame);
      return;
    }
    if (frame.type === "tool.result") {
      this.#finishTool(frame);
      return;
    }
    if (frame.type === "usage") {
      if (frame.turnId !== this.#activeTurn) return;
      this.emit({
        kind: "usage.reported",
        turnId: frame.turnId,
        inputTokens: frame.inputTokens,
        outputTokens: frame.outputTokens,
        sourceEventId: frame.sourceEventId,
      });
      return;
    }
    if (frame.type === "turn.done") {
      if (frame.turnId !== this.#activeTurn) return;
      this.emit({
        kind: "turn.finished",
        turnId: frame.turnId,
        outcome: frame.outcome,
        sourceEventId: frame.sourceEventId,
      });
      this.#activeTurn = undefined;
      this.#pending = undefined;
      this.#onTurnFinished();
    }
  }

  settlePending(decision: "allow" | "deny"): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.emit({
      kind: "interaction.resolved",
      turnId: pending.turnId,
      interactionId: pending.interactionId,
      decision,
    });
  }

  emit(body: Record<string, unknown>): void {
    const event = agentEventSchema.parse({
      hostSessionId: this.#hostSessionId,
      runtimeEpoch: this.#runtimeEpoch,
      sequence: this.#sequence + 1,
      eventId: this.#ids(),
      at: this.#now(),
      ...body,
    });
    this.#sequence = event.sequence;
    this.#events.push(event);
    for (const listener of Array.from(this.#listeners)) listener(event);
  }

  #holdTool(frame: Extract<PiPeerFrame, { type: "tool.pending" }>): void {
    if (frame.turnId !== this.#activeTurn) return;
    if (!CERTIFIED_TOOLS.has(frame.name)) {
      this.emit({
        kind: "session.error",
        code: "unsupported",
        message: "Pi tool is outside the certified read, write, and exec set",
        sourceEventId: frame.sourceEventId,
      });
      void this.#rpc.send({
        type: "approval.decision",
        turnId: frame.turnId,
        interactionId: frame.toolCallId,
        decision: "deny",
      });
      return;
    }
    this.#pending = {
      turnId: frame.turnId,
      interactionId: frame.toolCallId,
      name: frame.name,
      summary: frame.summary,
    };
    this.emit({
      kind: "interaction.requested",
      turnId: frame.turnId,
      interactionId: frame.toolCallId,
      toolCallId: frame.toolCallId,
      summary: frame.summary,
      sourceEventId: frame.sourceEventId,
    });
  }

  #finishTool(frame: Extract<PiPeerFrame, { type: "tool.result" }>): void {
    if (frame.turnId !== this.#activeTurn || !this.#startedTools.has(frame.toolCallId)) return;
    this.emit({
      kind: "tool.finished",
      turnId: frame.turnId,
      toolCallId: frame.toolCallId,
      name: frame.name,
      outcome: frame.outcome,
      ...(frame.outputText ? { outputText: frame.outputText } : {}),
      sourceEventId: frame.sourceEventId,
    });
    if (frame.outcome === "success" && frame.file) {
      this.emit({
        kind: "file.changed",
        turnId: frame.turnId,
        toolCallId: frame.toolCallId,
        name: frame.name,
        path: frame.file.path,
        additions: frame.file.additions,
        deletions: frame.file.deletions,
      });
    }
  }
}
