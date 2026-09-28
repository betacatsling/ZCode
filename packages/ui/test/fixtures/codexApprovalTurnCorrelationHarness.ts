import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { IAgentHostService } from "@zcode/services";
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
import { handleCodexServerRequest } from "../../../services/src/agent-adapters/codex/codexApprovalProtocol.js";
import type {
  CodexActiveTurn,
  CodexSessionRuntime,
  TurnCompletion,
} from "../../../services/src/agent-adapters/codex/codexRuntime.js";
import { createAgentHostConversationBridge } from "../../../services/src/agent-host/conversationBridge.js";
import type { HarnessAdapter } from "../../../services/src/agent-host/harnessRegistry.js";
import { AgentHostTargetService } from "../../../services/src/agent-host/targetService.js";

function completion(): { value: TurnCompletion; resolve(): void } {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let done = false;
  const value: TurnCompletion = {
    promise,
    resolve() {
      if (done) return;
      done = true;
      settle();
    },
    reject(error) {
      if (done) return;
      done = true;
      throw error;
    },
  };
  return { value, resolve: () => value.resolve() };
}

export class ReusedRpcApprovalHarness implements HarnessAdapter {
  readonly id = "codex-correlation-fixture";
  readonly version = "0.157.1-test";
  readonly hostManagedRoute = "mock" as const;
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #state = new Map<
    string,
    { binding: BackendBinding; sequence: number; active?: CodexSessionRuntime; settle?: () => void }
  >();
  readonly respondedRpcIds: Array<{ id: string | number; decision: unknown }> = [];
  #holdResponse = false;
  #releaseResponse?: () => void;
  #resolutionEntered?: () => void;

  async probe(target: ExecutionTarget) {
    return target.available
      ? { support: "supported" as const }
      : { support: "unsupported" as const };
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const supported = { support: "supported" as const };
    return {
      text: supported,
      tools: supported,
      approvals: supported,
      cancelTurn: supported,
      history: supported,
      resumeExecution: { support: "unsupported", reason: "fixture" },
      images: { support: "unsupported", reason: "fixture" },
      modelSwitch: { support: "unsupported", reason: "fixture" },
    };
  }
  async hostManagedSupport(_target: ExecutionTarget) {
    return { support: "supported" as const };
  }
  async create(spec: SessionSpec, _plan: BindingPlan): Promise<BackendBinding> {
    const binding: BackendBinding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: "opaque-codex-thread",
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    };
    this.#state.set(spec.hostSessionId, { binding, sequence: 0 });
    return binding;
  }
  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    _lastJournalSequence: number,
    _plan: BindingPlan,
  ): Promise<void> {
    assert.equal(
      this.#state.get(spec.hostSessionId)?.binding.backendSessionId,
      binding.backendSessionId,
    );
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const state = this.#state.get(command.hostSessionId);
    assert.ok(state);
    const completionState = completion();
    const emit = (kind: AgentEvent["kind"], fields: Record<string, unknown>) => {
      const event = agentEventSchema.parse({
        hostSessionId: command.hostSessionId,
        runtimeEpoch: state.binding.runtimeEpoch,
        sequence: ++state.sequence,
        eventId: randomUUID(),
        at: Date.now(),
        kind,
        ...fields,
      });
      for (const listener of this.#listeners.get(command.hostSessionId) ?? []) listener(event);
    };
    const activeTurn: CodexActiveTurn = {
      hostTurnId: command.turnId,
      backendTurnId: `backend-${command.turnId}`,
      started: false,
      completion: completionState.value,
    };
    const process = {
      rejectServerRequest: async () => {},
      respondToServerRequest: async (id: string | number, result: unknown) => {
        if (this.#holdResponse) {
          this.#holdResponse = false;
          this.#resolutionEntered?.();
          await new Promise<void>((resolve) => {
            this.#releaseResponse = resolve;
          });
        }
        this.respondedRpcIds.push({ id, decision: result });
      },
    };
    const runtime: CodexSessionRuntime = {
      spec: { hostSessionId: command.hostSessionId } as SessionSpec,
      plan: {} as BindingPlan,
      binding: state.binding,
      model: {} as never,
      gateway: {} as never,
      grant: {} as never,
      process: process as never,
      threadId: "opaque-codex-thread",
      sequence: { value: state.sequence },
      pendingApprovals: new Map(),
      resolvedRequestIds: new Set(),
      resolvingRequestIds: new Set(),
      messages: new Map(),
      tools: new Map(),
      emit,
      activeTurn,
      stopping: false,
    };
    state.active = runtime;
    state.settle = completionState.resolve;
    await handleCodexServerRequest(runtime, {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: runtime.threadId,
        turnId: activeTurn.backendTurnId,
        itemId: "reused-native-item-id",
        command: "printf fixture",
      },
    });
    await completionState.value.promise;
    emit("turn.finished", { turnId: command.turnId, outcome: "success" });
    state.active = undefined;
    state.settle = undefined;
  }
  async cancelTurn(): Promise<void> {
    throw new Error("fixture cancellation is not used");
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const state = this.#state.get(command.hostSessionId);
    const runtime = state?.active;
    const pending = runtime?.pendingApprovals.get(command.interactionId);
    if (
      !runtime ||
      !runtime.activeTurn ||
      runtime.activeTurn.hostTurnId !== command.turnId ||
      !pending
    )
      throw new Error("stale Codex approval interaction");
    const requestKey = `${pending.hostTurnId}:${typeof pending.rpcId}:${pending.rpcId}`;
    if (runtime.resolvedRequestIds.has(requestKey) || runtime.resolvingRequestIds.has(requestKey))
      throw new Error("Codex approval request already has a winning resolution");
    runtime.resolvingRequestIds.add(requestKey);
    try {
      await runtime.process.respondToServerRequest(pending.rpcId, {
        decision: command.decision === "allow" ? "accept" : "decline",
      });
      runtime.pendingApprovals.delete(command.interactionId);
      runtime.resolvedRequestIds.add(requestKey);
      runtime.emit("interaction.resolved", {
        turnId: command.turnId,
        interactionId: pending.interactionId,
        decision: command.decision,
      });
      runtime.activeTurn = undefined;
      state?.settle?.();
    } finally {
      runtime.resolvingRequestIds.delete(requestKey);
    }
  }
  async terminate(): Promise<void> {
    for (const state of this.#state.values()) state.active?.activeTurn?.completion.resolve();
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    let listeners = this.#listeners.get(hostSessionId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(hostSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (!listeners?.size) this.#listeners.delete(hostSessionId);
    };
  }
  holdNextResolution(): Promise<void> {
    this.#holdResponse = true;
    return new Promise<void>((resolve) => {
      this.#resolutionEntered = resolve;
    });
  }
  releaseHeldResolution(): void {
    this.#releaseResponse?.();
    this.#releaseResponse = undefined;
  }
}

export function createClient(
  target: AgentHostTargetService,
  bridge: ReturnType<typeof createAgentHostConversationBridge>,
): Pick<
  IAgentHostService,
  | "onConversationFrame"
  | "createExternalSession"
  | "subscribeConversation"
  | "resyncConversation"
  | "unsubscribeConversation"
  | "conversationRowsRange"
  | "dispatch"
  | "snapshot"
  | "queryCommand"
> {
  return {
    onConversationFrame: bridge.onFrame,
    createExternalSession: (request) => bridge.createExternalSession(request),
    subscribeConversation: (request) => bridge.subscribeConversation(request),
    resyncConversation: (request) => bridge.resyncConversation(request),
    unsubscribeConversation: (request) => bridge.unsubscribeConversation(request),
    conversationRowsRange: (request) => bridge.conversationRowsRange(request),
    dispatch: (session, command) => target.dispatch(session, command),
    snapshot: (session) => target.snapshot(session),
    queryCommand: (session, commandId) => target.queryCommand(session, commandId),
  };
}

export async function waitForInteraction(
  target: AgentHostTargetService,
  spec: SessionSpec,
  runtimeEpoch: string,
  wait: Promise<AgentEvent>,
) {
  await wait;
  const snapshot = await target.snapshot(spec);
  assert.equal(snapshot.logEpoch, runtimeEpoch);
  const interaction = snapshot.pendingInteractions[0];
  assert.ok(interaction);
  return { snapshot, interaction };
}

export function interactionEvent(target: AgentHostTargetService, hostSessionId: string) {
  return new Promise<AgentEvent>((resolve) => {
    const unsubscribe = target.subscribe(({ spec, event }) => {
      if (spec.hostSessionId !== hostSessionId || event.kind !== "interaction.requested") return;
      unsubscribe();
      resolve(event);
    });
  });
}
