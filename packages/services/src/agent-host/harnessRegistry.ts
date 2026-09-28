import type { Model } from "@zcode/contracts";
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

/** Per-operation binding passed from the Host; it never crosses the V4 command protocol. */
export interface PreparedHostBinding {
  readonly plan: BindingPlan;
  readonly model?: Model;
  readonly turnId?: string;
}

/** Adapter owns backend control. The host owns IDs, persistence and admission. */
export interface HarnessAdapter {
  readonly id: string;
  readonly version: string;
  readonly hostManagedRoute: BindingPlan["route"];
  probe(target: ExecutionTarget): Promise<CapabilityReport>;
  capabilities(target: ExecutionTarget): Promise<HarnessCapabilities>;
  hostManagedSupport(target: ExecutionTarget, selection: ModelSelection): Promise<CapabilityReport>;
  /** Native-account route is opt-in, not an implicit fallback from host-managed. */
  harnessManagedSupport?(
    target: ExecutionTarget,
    nativeModelId?: string,
  ): Promise<CapabilityReport>;
  prepareModel?(spec: SessionSpec, plan: BindingPlan): Promise<Model> | Model;
  /** Must not submit user input or trigger a Model/tool request. */
  prepareTurn?(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void>;
  discardPreparedTurn?(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void>;
  create(
    spec: SessionSpec,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<BackendBinding>;
  attach(
    spec: SessionSpec,
    binding: BackendBinding,
    lastJournalSequence: number,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<void>;
  send(
    command: Extract<AgentCommand, { type: "send" }>,
    prepared?: PreparedHostBinding,
  ): Promise<void>;
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
