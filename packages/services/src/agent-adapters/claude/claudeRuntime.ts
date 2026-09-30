import type { Model } from "@zcode/contracts";
import type {
  AgentEvent,
  BackendBinding,
  BindingPlan,
  SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelGateway, ModelGatewayGrant } from "@zcode/services/model-gateway";
import type { ClaudeSessionProfile } from "./claudeProfile.js";
import type { ClaudeApprovalHookServer } from "./claudeApprovalHookServer.js";
import type { ClaudeStreamProcess } from "./claudeStreamProcess.js";

export interface ClaudeTurnCompletion {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export interface ClaudeActiveTurn {
  readonly hostTurnId: string;
  readonly completion: ClaudeTurnCompletion;
  readonly seenToolIds: Set<string>;
  readonly requestedToolIds: Set<string>;
  readonly approvedToolIds: Set<string>;
  started: boolean;
}

export interface ClaudeToolCallRecord {
  readonly nativeToolUseId: string;
  readonly hostToolCallId: string;
  readonly name: string;
  inputText: string;
  input?: Record<string, unknown>;
  finished: boolean;
}

export interface ClaudePendingApproval {
  readonly nativeToolUseId: string;
  readonly interactionId: string;
  readonly toolCallId: string;
  readonly hostTurnId: string;
  readonly runtimeEpoch: string;
  readonly decision: Promise<"allow" | "deny">;
  decide(value: "allow" | "deny"): boolean;
  state: "pending" | "resolved";
}

export interface ClaudeSessionRuntime {
  readonly spec: SessionSpec;
  plan: BindingPlan;
  readonly binding: BackendBinding;
  model: Model;
  gateway: ModelGateway;
  grant: ModelGatewayGrant;
  profile: ClaudeSessionProfile;
  process: ClaudeStreamProcess;
  hookServer: ClaudeApprovalHookServer;
  readonly emit: (kind: AgentEvent["kind"], fields: Record<string, unknown>) => void;
  readonly sequence: { value: number };
  readonly toolCalls: Map<string, ClaudeToolCallRecord>;
  readonly toolBlocks: Map<string, ClaudeToolCallRecord>;
  readonly pendingApprovals: Map<string, ClaudePendingApproval>;
  readonly resolvedInteractionIds: Set<string>;
  activeTurn?: ClaudeActiveTurn;
  preparedTurnId?: string;
  initialized: boolean;
  stopping: boolean;
  failed?: Error;
  stopPromise?: Promise<void>;
  turnLeaseTimer?: ReturnType<typeof setInterval>;
  activeNativeMessageId?: string;
}

export function createClaudeTurnCompletion(): ClaudeTurnCompletion {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  let settled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve() {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

export function createClaudeDecision(): {
  readonly promise: Promise<"allow" | "deny">;
  decide(value: "allow" | "deny"): boolean;
} {
  let resolve!: (value: "allow" | "deny") => void;
  let settled = false;
  const promise = new Promise<"allow" | "deny">((complete) => {
    resolve = complete;
  });
  return {
    promise,
    decide(value) {
      if (settled) return false;
      settled = true;
      resolve(value);
      return true;
    },
  };
}

export function claudeTurnToolId(
  runtime: ClaudeSessionRuntime,
  turnId: string,
  nativeId: string,
): string {
  return `claude:${runtime.binding.runtimeEpoch}:${turnId}:${nativeId}`;
}

export function claudeTurnMessageId(
  runtime: ClaudeSessionRuntime,
  turnId: string,
  nativeId: string,
): string {
  return `claude:${runtime.binding.runtimeEpoch}:${turnId}:message:${nativeId}`;
}
