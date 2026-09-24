import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  AgentCommand,
  AgentEvent,
  BackendBinding,
  BindingPlan,
  CapabilityReport,
  ExecutionTarget,
  HarnessCapabilities,
  SessionSpec,
} from "@zcode/shared/agent-host";

/** Adapter owns backend control. The host owns IDs, persistence and admission. */
export interface HarnessAdapter {
  readonly id: string;
  readonly version: string;
  readonly hostManagedRoute: BindingPlan["route"];
  probe(target: ExecutionTarget): Promise<CapabilityReport>;
  capabilities(target: ExecutionTarget): Promise<HarnessCapabilities>;
  hostManagedSupport(target: ExecutionTarget, selection: ModelSelection): Promise<CapabilityReport>;
  /** Native-account route is opt-in, not an implicit fallback from host-managed. */
  harnessManagedSupport?(target: ExecutionTarget, nativeModelId?: string): Promise<CapabilityReport>;
  create(spec: SessionSpec, plan: BindingPlan): Promise<BackendBinding>;
  attach(spec: SessionSpec, binding: BackendBinding, lastJournalSequence: number, plan: BindingPlan): Promise<void>;
  send(command: Extract<AgentCommand, { type: "send" }>): Promise<void>;
  cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void>;
  resolveInteraction(command: Extract<AgentCommand, { type: "resolveInteraction" }>): Promise<void>;
  terminate(hostSessionId: string): Promise<void>;
  /** Target process shutdown only, never renderer detach. Interrupted sends become uncertain. */
  shutdown?(): Promise<void>;
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void;
}

export class HarnessRegistry {
  readonly #harnesses = new Map<string, HarnessAdapter>();

  register(harness: HarnessAdapter): void {
    if (!harness.id || !harness.version || this.#harnesses.has(harness.id)) {
      throw new Error(`duplicate or invalid harness: ${harness.id}`);
    }
    this.#harnesses.set(harness.id, harness);
  }

  require(id: string): HarnessAdapter {
    const harness = this.#harnesses.get(id);
    if (!harness) throw new Error(`unknown harness: ${id}`);
    return harness;
  }

  list(): readonly HarnessAdapter[] {
    return [...this.#harnesses.values()];
  }
}
