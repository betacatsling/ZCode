import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  AgentCommand,
  BindingPlan,
  SessionSpec,
} from "@zcode/shared/agent-host";
import type { PreparedHostBinding } from "../../agent-host/harnessRegistry.js";
import { MODEL_GATEWAY_TURN_LEASE_RENEW_INTERVAL_MS } from "@zcode/services/model-gateway";
import type { ClaudeActiveTurn, ClaudeSessionRuntime } from "./claudeRuntime.js";
import { claudeTurnMessageId, createClaudeTurnCompletion } from "./claudeRuntime.js";

export interface ClaudeTurnLifecyclePorts {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly hostManagedRoute: BindingPlan["route"];
  readonly grantLifetimeMs: number;
  readonly isMessagesSelection: (selection: ModelSelection) => boolean;
  readonly isSelectionAuthorized: (plan: BindingPlan) => boolean;
  requireRuntime(hostSessionId: string): ClaudeSessionRuntime;
  replaceIdleBinding(
    runtime: ClaudeSessionRuntime,
    prepared: PreparedHostBinding,
  ): Promise<ClaudeSessionRuntime>;
  stopRuntime(runtime: ClaudeSessionRuntime): Promise<void>;
  markUnknown(runtime: ClaudeSessionRuntime, turn: ClaudeActiveTurn, message: string): void;
}

/** Owns the Messages grant lease while SessionHost remains the only command admission owner. */
export class ClaudeTurnLifecycle {
  constructor(
    private readonly ports: ClaudeTurnLifecyclePorts,
    private readonly leaseRenewIntervalMs = MODEL_GATEWAY_TURN_LEASE_RENEW_INTERVAL_MS,
  ) {}

  async prepare(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void> {
    const { plan, model, turnId } = prepared;
    validateBinding({
      spec,
      plan,
      model,
      turnId,
      adapterId: this.ports.adapterId,
      adapterVersion: this.ports.adapterVersion,
      hostManagedRoute: this.ports.hostManagedRoute,
      isMessagesSelection: this.ports.isMessagesSelection,
      isSelectionAuthorized: this.ports.isSelectionAuthorized,
    });
    let runtime = this.ports.requireRuntime(spec.hostSessionId);
    if (runtime.activeTurn || runtime.preparedTurnId)
      throw new Error("Claude runtime is not idle for turn binding preparation");

    if (runtime.failed || !runtime.process.isRunning || !sameClaudeBinding(runtime.plan, plan)) {
      runtime = await this.ports.replaceIdleBinding(runtime, prepared);
    } else {
      runtime.gateway.renewGrant(runtime.grant.id, {
        expectedModelBindingFingerprint: plan.catalogFingerprint,
        expiresInMs: this.ports.grantLifetimeMs,
      });
    }
    runtime.gateway.beginTurnLease(runtime.grant.id, turnId!);
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
      throw new Error("Claude turn lease does not match the prepared or active Host turn");
    if (!this.ports.isSelectionAuthorized(runtime.plan)) {
      runtime.failed = new Error("Claude Model selection was revoked during the active turn");
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
      throw new Error("foreign Claude Host session");
    if (
      !prepared ||
      prepared.turnId !== command.turnId ||
      runtime.preparedTurnId !== command.turnId
    ) {
      throw new Error("Claude send has no matching pre-accepted turn lease");
    }
    if (runtime.failed || runtime.stopping || !runtime.process.isRunning)
      throw new Error("Claude backend is unavailable; inspect history before recovery");
    if (runtime.activeTurn) throw new Error("Claude backend is already executing a Host turn");

    runtime.toolCalls.clear();
    runtime.toolBlocks.clear();
    runtime.activeNativeMessageId = undefined;
    const turn: ClaudeActiveTurn = {
      hostTurnId: command.turnId,
      completion: createClaudeTurnCompletion(),
      seenToolIds: new Set(),
      requestedToolIds: new Set(),
      approvedToolIds: new Set(),
      started: false,
    };
    void turn.completion.promise.catch(() => undefined);
    runtime.activeTurn = turn;
    runtime.emit("message.finished", {
      turnId: command.turnId,
      messageId: claudeTurnMessageId(runtime, command.turnId, `host-input-${command.turnId}`),
      role: "user",
      text: command.text,
    });
    const renewal = setInterval(() => {
      try {
        this.renew(command.hostSessionId, command.turnId);
      } catch (error) {
        runtime.failed = error instanceof Error ? error : new Error("Claude turn lease renewal failed");
        void this.ports.stopRuntime(runtime).catch(() => undefined);
      }
    }, this.leaseRenewIntervalMs);
    renewal.unref();
    try {
      await runtime.process.sendUserMessage(command.text);
      await turn.completion.promise;
    } catch (error) {
      if (runtime.activeTurn === turn)
        this.ports.markUnknown(runtime, turn, "Claude did not confirm the accepted turn outcome.");
      throw error instanceof Error ? error : new Error("Claude structured send failed");
    } finally {
      clearInterval(renewal);
      if (runtime.preparedTurnId === command.turnId) runtime.preparedTurnId = undefined;
      try {
        runtime.gateway.endTurnLease(runtime.grant.id, command.turnId);
      } catch {
        // Revocation already aborted the bound Model request and removed the lease.
      }
    }
  }
}

function validateBinding(input: {
  readonly spec: SessionSpec;
  readonly plan: BindingPlan;
  readonly model?: ClaudeSessionRuntime["model"];
  readonly turnId?: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly hostManagedRoute: BindingPlan["route"];
  readonly isMessagesSelection: (selection: ModelSelection) => boolean;
  readonly isSelectionAuthorized: (plan: BindingPlan) => boolean;
}): void {
  const { spec, plan, model } = input;
  const hasFakeEvidence =
    plan.support.constraints?.compatibilityEvidence === "fake-model-fixture" &&
    typeof plan.support.constraints.fixtureId === "string" &&
    plan.support.constraints.fixtureId.length > 0 &&
    plan.support.constraints.fixtureProviderId === plan.effective?.providerId &&
    plan.support.constraints.fixtureModelId === plan.effective?.modelId;
  if (
    !input.turnId ||
    !model ||
    spec.modelBinding.kind !== "host-managed" ||
    spec.harness.id !== input.adapterId ||
    spec.harness.adapterVersion !== input.adapterVersion ||
    plan.hostSessionId !== spec.hostSessionId ||
    plan.harnessId !== input.adapterId ||
    plan.adapterVersion !== input.adapterVersion ||
    plan.targetId !== spec.execution.targetId ||
    plan.route !== input.hostManagedRoute ||
    plan.support.support !== "supported" ||
    !hasFakeEvidence ||
    !plan.effective ||
    JSON.stringify(plan.requested) !== JSON.stringify(spec.modelBinding) ||
    !input.isMessagesSelection(plan.effective) ||
    model.providerId !== plan.effective.providerId ||
    model.modelId !== plan.effective.modelId ||
    model.options.reasoningLevel !== plan.effective.options?.reasoningLevel ||
    !input.isSelectionAuthorized(plan)
  ) {
    throw new Error("Claude adapter requires an exact pinned Messages FakeModel binding");
  }
}

function sameClaudeBinding(previous: BindingPlan, next: BindingPlan): boolean {
  return (
    previous.catalogFingerprint === next.catalogFingerprint &&
    previous.route === next.route &&
    JSON.stringify(previous.requested) === JSON.stringify(next.requested) &&
    JSON.stringify(previous.effective) === JSON.stringify(next.effective) &&
    previous.credentialSource === next.credentialSource
  );
}
