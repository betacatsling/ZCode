import { agentEventSchema, type AgentEvent } from "@zcode/shared/agent-host";
import {
  acpInitializeParams,
  isRecord,
  negotiateAcpInitialize,
  type AcpNegotiation,
} from "./acpProtocol.js";
import { AcpRpc, type AcpJsonRpcMessage, type AcpTransport } from "./acpTransport.js";
import { translateAcpUpdate } from "./acpTranslate.js";

interface ActiveTurn {
  id: string;
  text: string;
  cancelled: boolean;
}

interface PendingPermission {
  id: string | number;
  turnId: string;
  interactionId: string;
  allowOptionId?: string;
  rejectOptionId?: string;
}

/**
 * 所有 ACP Agent 共用的连接状态机。产品名不能进入这里。
 * session/load 与 session/resume 只跟本次协商结果走。
 */
export class AcpSessionMachine {
  readonly #hostSessionId: string;
  readonly #cwd: string;
  readonly #now: () => number;
  readonly #onEvent: (event: AgentEvent) => void;
  readonly #rpc: AcpRpc;
  readonly #history: AgentEvent[] = [];
  readonly #seen = new Set<string>();
  readonly #startedTools = new Set<string>();
  #negotiation?: AcpNegotiation;
  #sessionId?: string;
  #epoch?: string;
  #sequence = 0;
  #turn?: ActiveTurn;
  #permission?: PendingPermission;
  #replaying = false;
  #replayed = 0;
  #closed = false;

  constructor(input: {
    hostSessionId: string;
    cwd: string;
    transport: AcpTransport;
    now?: () => number;
    onEvent: (event: AgentEvent) => void;
  }) {
    this.#hostSessionId = input.hostSessionId;
    this.#cwd = input.cwd;
    this.#now = input.now ?? Date.now;
    this.#onEvent = input.onEvent;
    this.#rpc = new AcpRpc(
      input.transport,
      (message) => this.#onRequest(message),
      (message) => {
        this.#onNotification(message);
      },
    );
  }

  negotiation(): AcpNegotiation | undefined {
    return this.#negotiation;
  }

  backendSessionId(): string | undefined {
    return this.#sessionId;
  }

  history(): readonly AgentEvent[] {
    return this.#history;
  }

  bindRuntime(runtimeEpoch: string, lastSequence: number): void {
    this.#epoch = runtimeEpoch;
    this.#sequence = lastSequence;
  }

  async initialize(): Promise<AcpNegotiation> {
    const negotiation = negotiateAcpInitialize(
      await this.#rpc.request("initialize", acpInitializeParams()),
    );
    this.#negotiation = negotiation;
    return negotiation;
  }

  async openNewSession(): Promise<string> {
    this.#assertAdmission();
    const result = await this.#rpc.request("session/new", { cwd: this.#cwd, mcpServers: [] });
    const sessionId = readSessionId(result);
    if (!sessionId) throw new Error("ACP session/new did not return a session id");
    this.#sessionId = sessionId;
    return sessionId;
  }

  /**
   * 未协商时直接拒绝，不能改走 session/new 或重放 prompt。
   * load 回放期间的更新不写入宿主正文。
   */
  async resumeNative(
    sessionId: string,
  ): Promise<{ method: "session/load" | "session/resume"; replaysHistory: boolean }> {
    const negotiation = this.#negotiation;
    if (!negotiation || negotiation.stability !== "stable") {
      throw new Error(
        `experimental: ${negotiation?.stabilityReason ?? "ACP protocol version is not stable"}`,
      );
    }
    if (!negotiation.loadSession && !negotiation.resumeSession) {
      throw new Error("unsupported: ACP session resume was not negotiated");
    }
    const method = negotiation.loadSession ? "session/load" : "session/resume";
    this.#replaying = true;
    this.#replayed = 0;
    try {
      await this.#rpc.request(method, {
        sessionId,
        cwd: this.#cwd,
        ...(method === "session/load" ? { mcpServers: [] } : {}),
      });
    } finally {
      this.#replaying = false;
    }
    this.#sessionId = sessionId;
    if (this.#replayed > 0) {
      this.#emit("extension.event", {
        namespace: "acp.replay",
        version: 1,
        payload: { replayedUpdates: this.#replayed, applied: false },
      });
    }
    return { method, replaysHistory: method === "session/load" };
  }

  async prompt(turnId: string, text: string): Promise<void> {
    if (!this.#sessionId || !this.#epoch) throw new Error("ACP session is not open");
    if (this.#turn) throw new Error("session busy");
    this.#assertAdmission();
    this.#turn = { id: turnId, text: "", cancelled: false };
    this.#emit("turn.started", { turnId });
    let result: unknown;
    try {
      result = await this.#rpc.request("session/prompt", {
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text }],
      });
    } catch (error) {
      this.#finishTurn(undefined, error instanceof Error ? error.message : "ACP prompt failed");
      return;
    }
    this.#finishTurn(readStopReason(result));
  }

  async cancelTurn(turnId: string, runtimeEpoch: string): Promise<void> {
    this.#assertTurn(turnId, runtimeEpoch);
    if (!this.#turn || !this.#sessionId) throw new Error("stale-turn");
    this.#turn.cancelled = true;
    await this.#rpc.notify("session/cancel", { sessionId: this.#sessionId });
    const permission = this.#permission;
    if (permission?.turnId !== turnId) return;
    this.#permission = undefined;
    if (permission.rejectOptionId) {
      await this.#rpc.respond(permission.id, selected(permission.rejectOptionId));
      return;
    }
    await this.#rpc.fail(permission.id, -32602, "cancelled");
  }

  async resolveInteraction(input: {
    turnId: string;
    runtimeEpoch: string;
    interactionId: string;
    decision: "allow" | "deny";
  }): Promise<void> {
    this.#assertTurn(input.turnId, input.runtimeEpoch);
    const permission = this.#permission;
    if (!permission || permission.interactionId !== input.interactionId)
      throw new Error("stale-interaction");
    const optionId =
      input.decision === "allow" ? permission.allowOptionId : permission.rejectOptionId;
    if (!optionId) throw new Error("unsupported: ACP permission has no matching option");
    this.#permission = undefined;
    this.#emit("interaction.resolved", {
      turnId: input.turnId,
      interactionId: input.interactionId,
      decision: input.decision,
    });
    await this.#rpc.respond(permission.id, selected(optionId));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#rpc.close();
  }

  #assertAdmission(): void {
    const negotiation = this.#negotiation;
    if (!negotiation) throw new Error("ACP initialize did not complete");
    if (negotiation.stability !== "stable") {
      throw new Error(
        `experimental: ${negotiation.stabilityReason ?? "ACP protocol version is not stable"}`,
      );
    }
    if (negotiation.authMethods.length > 0) {
      const ids = negotiation.authMethods.map((method) => method.methodId).join(", ");
      throw new Error(
        `unsupported: ACP auth methods were advertised (${ids}) and this adapter does not submit credentials`,
      );
    }
  }

  #assertTurn(turnId: string, runtimeEpoch: string): void {
    if (this.#epoch !== runtimeEpoch) throw new Error("stale-epoch");
    if (this.#turn?.id !== turnId) throw new Error("stale-turn");
  }

  #onRequest(message: AcpJsonRpcMessage): void {
    if (
      message.method === "session/request_permission" &&
      message.id !== undefined &&
      message.id !== null
    ) {
      this.#requestPermission(message.id, message.params);
      return;
    }
    // 未知扩展、文件和终端方法都不执行，也不把参数写进宿主事件。
    if (message.id !== undefined && message.id !== null) {
      void this.#rpc.fail(message.id, -32601, "unsupported ACP extension");
    }
  }

  #requestPermission(id: string | number, params: unknown): void {
    const turn = this.#turn;
    if (!turn || !isRecord(params)) {
      void this.#rpc.fail(id, -32602, "stale ACP permission");
      return;
    }
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "tool";
    const options = Array.isArray(params.options) ? params.options : [];
    const allowOptionId = optionId(options, "allow_once") ?? optionId(options, "allow_always");
    const rejectOptionId = optionId(options, "reject_once") ?? optionId(options, "reject_always");
    if (!allowOptionId || !rejectOptionId) {
      void this.#rpc.fail(id, -32602, "unsupported ACP permission");
      return;
    }
    const interactionId = `acp-permission:${toolCallId}`;
    this.#permission = { id, turnId: turn.id, interactionId, allowOptionId, rejectOptionId };
    const summary =
      typeof toolCall.title === "string" && toolCall.title.trim()
        ? toolCall.title
        : "ACP permission";
    this.#emit("interaction.requested", { turnId: turn.id, interactionId, toolCallId, summary });
  }

  #onNotification(message: AcpJsonRpcMessage): void {
    if (message.method !== "session/update") return;
    if (!isRecord(message.params)) return;
    const sessionId = message.params.sessionId;
    if (typeof sessionId === "string" && this.#sessionId && sessionId !== this.#sessionId) return;
    // load 的回放发生在轮次之外，不能因为没有 turn 就把它写进正文。
    if (this.#replaying) {
      this.#replayed += 1;
      return;
    }
    if (!this.#turn) return;
    const drafts = translateAcpUpdate({
      update: message.params.update,
      turnId: this.#turn.id,
      startedTools: this.#startedTools,
    });
    for (const draft of drafts) {
      if (draft.kind === "text.delta" && typeof draft.fields.text === "string")
        this.#turn.text += draft.fields.text;
      this.#emit(draft.kind, draft.fields, draft.sourceEventId);
    }
  }

  #finishTurn(stopReason: string | undefined, failure?: string): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = undefined;
    if (turn.text) {
      this.#emit("message.finished", {
        turnId: turn.id,
        messageId: `assistant-${turn.id}`,
        role: "assistant",
        text: turn.text,
      });
    }
    const outcome = turn.cancelled
      ? "cancelled"
      : stopReason === "end_turn"
        ? "success"
        : stopReason
          ? "failed"
          : "unknown";
    if (!stopReason || failure) {
      this.#emit("session.error", {
        code: "backend-failure",
        message: (failure ?? "ACP prompt ended without a stop reason").slice(0, 1024),
      });
    }
    this.#emit("turn.finished", { turnId: turn.id, outcome });
  }

  #emit(kind: AgentEvent["kind"], fields: Record<string, unknown>, sourceEventId?: string): void {
    if (!this.#epoch) throw new Error("ACP runtime epoch is not bound");
    if (sourceEventId && this.#seen.has(sourceEventId)) return;
    if (sourceEventId) this.#seen.add(sourceEventId);
    const event = agentEventSchema.parse({
      hostSessionId: this.#hostSessionId,
      runtimeEpoch: this.#epoch,
      sequence: this.#sequence + 1,
      eventId: `${this.#hostSessionId}:${this.#sequence + 1}`,
      ...(sourceEventId ? { sourceEventId } : {}),
      at: this.#now(),
      kind,
      ...fields,
    });
    this.#sequence = event.sequence;
    this.#history.push(event);
    this.#onEvent(event);
  }
}

function selected(optionId: string): Record<string, unknown> {
  return { outcome: { outcome: "selected", optionId } };
}

function optionId(options: readonly unknown[], kind: string): string | undefined {
  for (const option of options) {
    if (!isRecord(option) || option.kind !== kind || typeof option.optionId !== "string") continue;
    return option.optionId;
  }
  return undefined;
}

function readSessionId(result: unknown): string | undefined {
  if (!isRecord(result) || typeof result.sessionId !== "string" || !result.sessionId.trim())
    return undefined;
  return result.sessionId;
}

function readStopReason(result: unknown): string | undefined {
  if (!isRecord(result) || typeof result.stopReason !== "string") return undefined;
  return result.stopReason;
}
