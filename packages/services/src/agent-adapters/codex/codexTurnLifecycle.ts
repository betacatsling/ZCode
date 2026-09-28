import type { ModelSelection } from "@zcode/shared/model-selection";
import type { AgentCommand, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { PreparedHostBinding } from "../../agent-host/harnessRegistry.js";
import {
  createTurnCompletion,
  type CodexActiveTurn,
  type CodexSessionRuntime,
} from "./codexRuntime.js";
import { emitTurnStarted } from "./codexEventTranslator.js";
import {
  CODEX_GRANT_LIFETIME_MS,
  CODEX_TURN_LEASE_RENEW_INTERVAL_MS,
} from "./codexTargetGateway.js";
import { validateCodexBinding } from "./codexBinding.js";

export interface CodexTurnLifecyclePorts {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly hostManagedRoute: BindingPlan["route"];
  readonly isOpenAiResponsesSelection: (selection: ModelSelection) => boolean;
  readonly isSelectionAuthorized: (plan: BindingPlan) => boolean;
  requireRuntime(hostSessionId: string): CodexSessionRuntime;
  replaceIdleBinding(
    runtime: CodexSessionRuntime,
    prepared: PreparedHostBinding,
  ): Promise<CodexSessionRuntime>;
  stopRuntime(runtime: CodexSessionRuntime): Promise<void>;
  markUnknown(runtime: CodexSessionRuntime, turn: CodexActiveTurn, message: string): void;
}

/** Owns per-turn Gateway lease timing while Host command admission stays in SessionHost. */
export class CodexTurnLifecycle {
  constructor(private readonly ports: CodexTurnLifecyclePorts) {}

  async prepare(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void> {
    const { plan, model, turnId } = prepared;
    if (
      !turnId ||
      !model ||
      spec.hostSessionId !== plan.hostSessionId ||
      plan.harnessId !== this.ports.adapterId ||
      plan.adapterVersion !== this.ports.adapterVersion ||
      plan.targetId !== spec.execution.targetId ||
      plan.route !== this.ports.hostManagedRoute ||
      model.providerId !== plan.effective?.providerId ||
      model.modelId !== plan.effective?.modelId ||
      !this.ports.isSelectionAuthorized(plan)
    ) {
      throw new Error("Codex turn binding is unsupported or its selection is no longer authorized");
    }
    let runtime = this.ports.requireRuntime(spec.hostSessionId);
    if (runtime.failed) throw runtime.failed;
    if (runtime.activeTurn || runtime.preparedTurnId)
      throw new Error("Codex runtime is not idle for turn binding preparation");
    validateCodexBinding({
      shuttingDown: runtime.stopping,
      spec,
      plan,
      adapterId: this.ports.adapterId,
      adapterVersion: this.ports.adapterVersion,
      hostManagedRoute: this.ports.hostManagedRoute,
      supportsOpenAiResponses: this.ports.isOpenAiResponsesSelection,
    });

    if (!sameCodexBinding(runtime.plan, plan)) {
      runtime = await this.ports.replaceIdleBinding(runtime, prepared);
    } else {
      runtime.gateway.renewGrant(runtime.grant.id, {
        expectedModelBindingFingerprint: plan.catalogFingerprint,
        expiresInMs: CODEX_GRANT_LIFETIME_MS,
      });
    }
    runtime.gateway.beginTurnLease(runtime.grant.id, turnId);
    runtime.preparedTurnId = turnId;
  }

  discard(spec: SessionSpec, prepared: PreparedHostBinding): void {
    if (!prepared.turnId) return;
    const runtime = this.ports.requireRuntime(spec.hostSessionId);
    if (runtime.preparedTurnId !== prepared.turnId) return;
    runtime.preparedTurnId = undefined;
    runtime.gateway.endTurnLease(runtime.grant.id, prepared.turnId);
  }

  renew(hostSessionId: string, turnId: string): { readonly expiresAt: number } {
    const runtime = this.ports.requireRuntime(hostSessionId);
    if (runtime.activeTurn?.hostTurnId !== turnId && runtime.preparedTurnId !== turnId)
      throw new Error("Codex turn lease does not match the prepared or active Host turn");
    if (!this.ports.isSelectionAuthorized(runtime.plan)) {
      runtime.failed = new Error("Codex model selection was revoked during the active turn");
      runtime.gateway.revoke(runtime.grant.id);
      if (runtime.activeTurn) void this.ports.stopRuntime(runtime).catch(() => undefined);
      throw runtime.failed;
    }
    return runtime.gateway.renewTurnLease(runtime.grant.id, turnId);
  }

  async send(
    command: Extract<AgentCommand, { type: "send" }>,
    prepared?: PreparedHostBinding,
  ): Promise<void> {
    const runtime = this.ports.requireRuntime(command.hostSessionId);
    if (runtime.binding.hostSessionId !== command.hostSessionId)
      throw new Error("foreign Codex Host session");
    if (runtime.activeTurn) throw new Error("Codex backend is already executing the Host turn");
    if (
      !prepared ||
      prepared.turnId !== command.turnId ||
      runtime.preparedTurnId !== command.turnId
    )
      throw new Error("Codex send has no matching pre-accepted turn lease");
    if (runtime.failed || runtime.stopping)
      throw new Error("Codex backend is unavailable; inspect history before recovery");

    const turn: CodexActiveTurn = {
      hostTurnId: command.turnId,
      started: false,
      completion: createTurnCompletion(),
    };
    void turn.completion.promise.catch(() => undefined);
    runtime.activeTurn = turn;
    const renewal = setInterval(() => {
      try {
        this.renew(command.hostSessionId, command.turnId);
      } catch (error) {
        runtime.failed =
          error instanceof Error ? error : new Error("Codex turn lease renewal failed");
        void this.ports.stopRuntime(runtime).catch(() => undefined);
      }
    }, CODEX_TURN_LEASE_RENEW_INTERVAL_MS);
    renewal.unref();
    try {
      turn.startRequest = runtime.process
        .request("turn/start", {
          threadId: runtime.threadId,
          input: [{ type: "text", text: command.text }],
          effort: "none",
          summary: "none",
        })
        .then((value) => {
          if (
            !isRecord(value) ||
            !isRecord(value.turn) ||
            typeof value.turn.id !== "string" ||
            !value.turn.id
          ) {
            throw new Error("Codex turn/start response omitted its turn id");
          }
          if (turn.backendTurnId && turn.backendTurnId !== value.turn.id)
            throw new Error("Codex turn id changed during start");
          turn.backendTurnId = value.turn.id;
          if (runtime.activeTurn === turn) emitTurnStarted(runtime.emit, turn);
        })
        .catch((error: unknown) => {
          this.ports.markUnknown(
            runtime,
            turn,
            "Codex could not confirm whether the accepted input executed.",
          );
          throw error instanceof Error ? error : new Error("Codex turn/start failed");
        });
      void turn.startRequest.catch(() => undefined);
      await turn.startRequest;
      await turn.completion.promise;
    } finally {
      clearInterval(renewal);
      if (runtime.preparedTurnId === command.turnId) runtime.preparedTurnId = undefined;
      try {
        runtime.gateway.endTurnLease(runtime.grant.id, command.turnId);
      } catch {
        // Revocation already aborts the bound request and permanently removes this lease.
      }
    }
  }
}

function sameCodexBinding(previous: BindingPlan, next: BindingPlan): boolean {
  return (
    previous.catalogFingerprint === next.catalogFingerprint &&
    previous.route === next.route &&
    JSON.stringify(previous.requested) === JSON.stringify(next.requested) &&
    JSON.stringify(previous.effective) === JSON.stringify(next.effective) &&
    previous.credentialSource === next.credentialSource
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
