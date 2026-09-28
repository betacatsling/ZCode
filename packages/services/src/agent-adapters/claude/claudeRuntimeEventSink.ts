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
import type { ClaudeSessionProfile } from "./claudeProfile.js";
import type { ClaudeApprovalHookServer } from "./claudeApprovalHookServer.js";
import type { ClaudeStreamProcess } from "./claudeStreamProcess.js";
import type { ClaudeSessionRuntime } from "./claudeRuntime.js";

export class ClaudeRuntimeEventSink {
  constructor(private readonly subscriptions: Map<string, Set<(event: AgentEvent) => void>>) {}

  createRuntime(input: {
    readonly spec: SessionSpec;
    readonly plan: BindingPlan;
    readonly binding: BackendBinding;
    readonly model: Model;
    readonly gateway: ModelGateway;
    readonly grant: ModelGatewayGrant;
    readonly profile: ClaudeSessionProfile;
    readonly process: ClaudeStreamProcess;
    readonly hookServer: ClaudeApprovalHookServer;
    readonly sequence: number;
  }): ClaudeSessionRuntime {
    const runtime: ClaudeSessionRuntime = {
      ...input,
      sequence: { value: input.sequence },
      toolCalls: new Map(),
      toolBlocks: new Map(),
      pendingApprovals: new Map(),
      resolvedInteractionIds: new Set(),
      initialized: false,
      stopping: false,
      emit: (kind, fields) => this.emit(runtime, kind, fields),
    };
    return runtime;
  }

  emit(
    runtime: ClaudeSessionRuntime,
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
}
