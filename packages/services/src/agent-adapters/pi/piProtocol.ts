import type { ModelRequest, ModelStreamEvent } from "@zcode/contracts";
import type { AgentEvent, BackendBinding, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";

export interface PiWorkerBoot {
  spec: SessionSpec;
  plan: BindingPlan;
  binding: BackendBinding;
  sessionDir: string;
  isolatedAgentDir: string;
  attach: boolean;
  sequence: number;
  model: {
    providerId: string;
    modelId: string;
    displayName?: string;
    properties: { contextWindow: number };
    optionSpecs: { maxOutputTokens: { max: number } };
    options: { reasoningLevel: string };
  };
}

/**
 * Key-free classification of a failed host model request. Optional on `model.failure`:
 * older hosts omit it and older workers ignore it.
 */
export interface PiModelFailure {
  reason: string;
  code?: string;
  providerId: string;
  modelId: string;
  statusCode?: number;
  retryable: boolean;
}

export type ToPiWorker =
  | { type: "send"; commandId: string; turnId: string; text: string }
  | { type: "cancel"; commandId: string; turnId: string }
  | { type: "resolve"; commandId: string; turnId: string; interactionId: string; decision: "allow" | "deny" }
  | { type: "terminate"; commandId: string }
  | { type: "model.event"; requestId: string; event: ModelStreamEvent }
  | { type: "model.done"; requestId: string }
  | { type: "model.failure"; requestId: string; failure?: PiModelFailure }
  | { type: "model.cancel"; requestId: string };

export type FromPiWorker =
  | { type: "ready"; backendSessionId: string }
  | { type: "event"; event: AgentEvent }
  | { type: "ack"; commandId: string; outcome: "completed" | "failed" }
  | { type: "model.request"; requestId: string; request: Omit<ModelRequest, "abortSignal"> }
  | { type: "model.abort"; requestId: string }
  | { type: "fatal"; message: string };
