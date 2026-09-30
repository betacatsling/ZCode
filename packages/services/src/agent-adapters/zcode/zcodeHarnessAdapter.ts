import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  agentCommandSchema,
  type AgentCommand,
  type AgentCommandReceipt,
  type AgentEvent,
  type BackendBinding,
  type BindingPlan,
  type CapabilityReport,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter, PreparedHostBinding } from "../../agent-host/harnessRegistry.js";

export const ZCODE_ADAPTER_VERSION = "native-v4";

/**
 * V4 remains the only writer. admit persists the command; dispatch runs it.
 * query is safe for reconnect and must not execute a prompt.
 */
export interface NativeV4CommandPort {
  query(hostSessionId: string, commandId: string): Promise<AgentCommandReceipt | undefined>;
  admit(command: AgentCommand): Promise<AgentCommandReceipt>;
  dispatch(command: AgentCommand): Promise<void>;
}

const NATIVE_ROUTE_ERROR = "native sessions must use the existing V4 route";

/** Forwards native sessions to the existing V4 owner. It does not keep a second session store. */
export class ZCodeHarnessAdapter implements HarnessAdapter {
  readonly id = "zcode";
  readonly version = ZCODE_ADAPTER_VERSION;
  readonly hostManagedRoute = "native" as const;

  constructor(private readonly port: NativeV4CommandPort) {}

  async probe(target: ExecutionTarget): Promise<CapabilityReport> {
    return target.available
      ? { support: "supported" }
      : { support: "unsupported", reason: "target unavailable" };
  }

  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const supported = { support: "supported" as const };
    return {
      text: supported,
      tools: supported,
      approvals: supported,
      cancelTurn: supported,
      resumeExecution: supported,
      history: supported,
      images: {
        support: "unknown",
        reason: "native image support is not certified by this facade",
      },
      modelSwitch: {
        support: "experimental",
        reason: "model changes stay on the existing V4 session and apply on a later turn",
      },
      detach: supported,
      terminateSession: supported,
      viewHistory: supported,
      hostManagedModel: {
        support: "supported",
        reason: "model requests stay on the existing V4 executor",
        constraints: { route: "native" },
      },
    };
  }

  async hostManagedSupport(
    _target: ExecutionTarget,
    selection: ModelSelection,
  ): Promise<CapabilityReport> {
    return {
      support: "supported",
      constraints: {
        route: "native",
        providerId: selection.providerId,
        modelId: selection.modelId,
      },
    };
  }

  async harnessManagedSupport(): Promise<CapabilityReport> {
    return {
      support: "unsupported",
      reason: "native ZCode has no separate harness-managed account route",
    };
  }

  async create(
    _spec: SessionSpec,
    _plan: BindingPlan,
    _prepared?: PreparedHostBinding,
  ): Promise<BackendBinding> {
    throw new Error(NATIVE_ROUTE_ERROR);
  }

  async attach(
    _spec: SessionSpec,
    _binding: BackendBinding,
    _lastJournalSequence: number,
    _plan: BindingPlan,
    _prepared?: PreparedHostBinding,
  ): Promise<void> {
    throw new Error(NATIVE_ROUTE_ERROR);
  }

  async send(
    _command: Extract<AgentCommand, { type: "send" }>,
    _prepared?: PreparedHostBinding,
  ): Promise<void> {
    throw new Error(NATIVE_ROUTE_ERROR);
  }

  async cancelTurn(_command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    throw new Error(NATIVE_ROUTE_ERROR);
  }

  async resolveInteraction(
    _command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    throw new Error(NATIVE_ROUTE_ERROR);
  }

  async terminate(_hostSessionId: string): Promise<void> {
    throw new Error(NATIVE_ROUTE_ERROR);
  }

  subscribe(_hostSessionId: string, _listener: (event: AgentEvent) => void): () => void {
    return () => undefined;
  }

  /**
   * 先查 receipt，没有记录才 admit。只有本次新 accepted 才派发。
   * 重连或崩溃后的 execution-unknown 停在查询，避免把可能已经执行的 prompt 再送一次。
   */
  async dispatchNative(raw: AgentCommand): Promise<AgentCommandReceipt> {
    const command = agentCommandSchema.parse(raw);
    const existing = await this.port.query(command.hostSessionId, command.commandId);
    if (existing) return seenReceipt(existing);
    const receipt = await this.port.admit(command);
    if (receipt.status !== "accepted") return receipt;
    await this.port.dispatch(command);
    return receipt;
  }

  /** Reconnect restores the stored receipt only. */
  reconnect(hostSessionId: string, commandId: string): Promise<AgentCommandReceipt | undefined> {
    return this.port.query(hostSessionId, commandId);
  }
}

function seenReceipt(receipt: AgentCommandReceipt): AgentCommandReceipt {
  return receipt.status === "accepted" ? { ...receipt, status: "duplicate" } : receipt;
}
