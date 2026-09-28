import type { Model } from "@zcode/contracts";
import type {
  AgentEvent,
  BackendBinding,
  BindingPlan,
  SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelGateway, ModelGatewayGrant } from "@zcode/services/model-gateway";
import type { CodexAppServerTransport, JsonRpcId } from "./codexAppServerProcess.js";

export interface TurnCompletion {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

export interface CodexActiveTurn {
  readonly hostTurnId: string;
  backendTurnId?: string;
  started: boolean;
  readonly completion: TurnCompletion;
  startRequest?: Promise<void>;
}

export interface CodexPendingApproval {
  readonly rpcId: JsonRpcId;
  readonly interactionId: string;
  readonly hostTurnId: string;
  readonly backendTurnId: string;
  readonly itemId: string;
  readonly toolCallId: string;
  readonly toolName: "exec_command" | "file_change";
  readonly summary: string;
}

export interface CodexSessionRuntime {
  readonly spec: SessionSpec;
  readonly plan: BindingPlan;
  readonly binding: BackendBinding;
  readonly model: Model;
  readonly gateway: ModelGateway;
  readonly grant: ModelGatewayGrant;
  readonly process: CodexAppServerTransport;
  readonly threadId: string;
  readonly sequence: { value: number };
  readonly pendingApprovals: Map<string, CodexPendingApproval>;
  readonly resolvedRequestIds: Set<string>;
  readonly resolvingRequestIds: Set<string>;
  readonly messages: Map<string, string>;
  readonly tools: Map<string, "exec_command" | "file_change">;
  readonly emit: (kind: AgentEvent["kind"], fields: Record<string, unknown>) => void;
  activeTurn?: CodexActiveTurn;
  preparedTurnId?: string;
  stopping: boolean;
  stopPromise?: Promise<void>;
  failed?: Error;
}

export function createTurnCompletion(): TurnCompletion {
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
