import type { ModelSelection } from "@zcode/shared/model-selection";
import { harnessManifestSchema, type HarnessManifest } from "@zcode/shared/agent-host";
import type {
  AgentCommand,
  AgentEvent,
  BackendBindingV2,
  BindingPlan,
  CapabilityReport,
  ExecutionTarget,
  HarnessCapabilities,
  HarnessCapabilitiesV2,
  SessionSpecV2,
} from "@zcode/shared/agent-host";

/** Adapter owns backend control. The host owns IDs, persistence and admission. */
export interface HarnessAdapter {
  readonly id: string;
  readonly version: string;
  readonly hostManagedRoute: BindingPlan["route"];
  probe(target: ExecutionTarget): Promise<CapabilityReport>;
  capabilities(target: ExecutionTarget): Promise<HarnessCapabilities | HarnessCapabilitiesV2>;
  hostManagedSupport(target: ExecutionTarget, selection: ModelSelection): Promise<CapabilityReport>;
  /** Native-account route is opt-in, not an implicit fallback from host-managed. */
  harnessManagedSupport?(
    target: ExecutionTarget,
    nativeModelId?: string,
  ): Promise<CapabilityReport>;
  create(spec: SessionSpecV2, plan: BindingPlan): Promise<BackendBindingV2>;
  attach(
    spec: SessionSpecV2,
    binding: BackendBindingV2,
    lastJournalSequence: number,
    plan: BindingPlan,
  ): Promise<void>;
  /** Prepare the actual immutable model route, without executing prompt or tools. */
  prepareTurn?(spec: SessionSpecV2, input: { turnId: string; runtimeEpoch: string; plan: BindingPlan }): Promise<void>;
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
  readonly #manifests = new Map<string, HarnessManifest>();

  /** Caller explicitly trusts this factory; never load executable code from a repository manifest. */
  registerTrusted(raw: HarnessManifest, factory: () => HarnessAdapter): void {
    const manifest = harnessManifestSchema.parse(raw);
    if (this.#harnesses.has(manifest.id)) throw new Error(`duplicate-id: ${manifest.id}`);
    const adapter = factory();
    if (adapter.id !== manifest.id || adapter.version !== manifest.adapterVersion)
      throw new Error("manifest adapter identity mismatch");
    this.register(adapter);
    this.#manifests.set(manifest.id, manifest);
  }

  manifest(id: string): HarnessManifest | undefined {
    return this.#manifests.get(id);
  }
  manifests(): readonly HarnessManifest[] {
    return [...this.#manifests.values()];
  }

  /** @deprecated direct registration for current native consumers; use registerTrusted for new adapters. */
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
