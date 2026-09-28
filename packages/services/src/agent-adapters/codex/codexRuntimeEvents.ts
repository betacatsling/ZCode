import { randomUUID } from "node:crypto";
import {
  agentEventSchema,
  type AgentEvent,
  type BackendBinding,
  type BindingPlan,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { Model } from "@zcode/contracts";
import type { ModelGateway, ModelGatewayGrant } from "@zcode/services/model-gateway";
import { emitTurnStarted } from "./codexEventTranslator.js";
import type { CodexActiveTurn, CodexSessionRuntime } from "./codexRuntime.js";
import type { CodexAppServerProcess } from "./codexAppServerProcess.js";

export class CodexRuntimeEvents {
  constructor(private readonly subscriptions: Map<string, Set<(event: AgentEvent) => void>>) {}

  createRuntime(input: {
    spec: SessionSpec;
    plan: BindingPlan;
    binding: BackendBinding;
    model: Model;
    gateway: ModelGateway;
    grant: ModelGatewayGrant;
    process: CodexAppServerProcess;
    threadId: string;
    sequence: number;
  }): CodexSessionRuntime {
    const runtime: CodexSessionRuntime = {
      ...input,
      sequence: { value: input.sequence },
      pendingApprovals: new Map(),
      resolvedRequestIds: new Set(),
      resolvingRequestIds: new Set(),
      messages: new Map(),
      tools: new Map(),
      stopping: false,
      emit: (kind, fields) => this.emit(runtime, kind, fields),
    };
    return runtime;
  }

  emit(
    runtime: CodexSessionRuntime,
    kind: AgentEvent["kind"],
    fields: Record<string, unknown>,
  ): void {
    const event = agentEventSchema.parse({
      hostSessionId: runtime.spec.hostSessionId,
      runtimeEpoch: runtime.binding.runtimeEpoch,
      sequence: ++runtime.sequence.value,
      eventId: randomUUID(),
      at: Date.now(),
      kind,
      ...fields,
    });
    for (const listener of this.subscriptions.get(runtime.spec.hostSessionId) ?? [])
      listener(event);
  }

  completeTurn(
    runtime: CodexSessionRuntime,
    turn: CodexActiveTurn,
    status: string,
    hasError: boolean,
  ): void {
    if (runtime.activeTurn !== turn) return;
    if (hasError)
      this.emit(runtime, "session.error", {
        code: "codex-turn-error",
        message: "Codex app-server reported a turn failure.",
      });
    const outcome =
      status === "completed"
        ? "success"
        : status === "interrupted" || status === "cancelled"
          ? "cancelled"
          : status === "failed"
            ? "failed"
            : "unknown";
    this.emit(runtime, "turn.finished", { turnId: turn.hostTurnId, outcome });
    this.#clearTurnCorrelations(runtime, turn);
    runtime.activeTurn = undefined;
    if (outcome === "unknown") {
      runtime.failed = new Error("Codex turn outcome is unknown");
      runtime.gateway.revoke(runtime.grant.id);
      turn.completion.reject(new Error("Codex turn outcome is unknown"));
    } else {
      turn.completion.resolve();
    }
  }

  markUnknown(runtime: CodexSessionRuntime, turn: CodexActiveTurn, message: string): void {
    if (runtime.activeTurn !== turn) return;
    emitTurnStarted(runtime.emit, turn);
    this.emit(runtime, "session.error", { code: "execution-unknown", message });
    this.emit(runtime, "turn.finished", { turnId: turn.hostTurnId, outcome: "unknown" });
    this.#clearTurnCorrelations(runtime, turn);
    runtime.activeTurn = undefined;
    turn.completion.reject(
      new Error("Codex accepted input may have executed; inspect history before recovery"),
    );
  }

  fail(runtime: CodexSessionRuntime, error: Error): void {
    if (runtime.stopping || runtime.failed) return;
    runtime.failed = error;
    runtime.gateway.revoke(runtime.grant.id);
    this.emit(runtime, "session.error", {
      code: "codex-process-failure",
      message: "Codex app-server stopped unexpectedly; execution outcome may be unknown.",
    });
    if (runtime.activeTurn)
      this.markUnknown(
        runtime,
        runtime.activeTurn,
        "Codex app-server stopped before confirming the accepted turn outcome.",
      );
  }

  #clearTurnCorrelations(runtime: CodexSessionRuntime, turn: CodexActiveTurn): void {
    for (const [interactionId, approval] of runtime.pendingApprovals) {
      if (approval.hostTurnId === turn.hostTurnId) {
        runtime.pendingApprovals.delete(interactionId);
      }
    }
    const requestPrefix = `${turn.hostTurnId}:`;
    for (const requestKey of runtime.resolvingRequestIds) {
      if (requestKey.startsWith(requestPrefix)) runtime.resolvingRequestIds.delete(requestKey);
    }
    for (const requestKey of runtime.resolvedRequestIds) {
      if (requestKey.startsWith(requestPrefix)) runtime.resolvedRequestIds.delete(requestKey);
    }
    runtime.messages.clear();
    runtime.tools.clear();
  }
}
