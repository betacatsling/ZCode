import type { AgentCommand, AgentCommandReceipt, AgentEvent, ExecutionTarget, HarnessCatalogEntry, HarnessCapabilitiesV2, LegacySessionSpec, SessionSpecV2, StoredAgentSessionSummary } from "@zcode/shared/agent-host";
import { harnessCapabilitiesV2Schema, readableSessionSpecSchema, writableSessionSpecV2Schema } from "@zcode/shared/agent-host";
import type { ConversationSnapshot, V4ConversationRowsRangeParams, V4ConversationRowsRangeResult } from "@zcode/shared/zcode-protocol-v4";
import { HarnessRegistry } from "./harnessRegistry.js";
import { SessionHost } from "./sessionHost.js";
import type { ModelCatalogPort } from "./modelBindingPlanner.js";

export interface TargetHostEvent { spec: SessionSpecV2; event: AgentEvent }

/** WorktreeService adapter verifies stored ownership, Git membership, generation and canonical contained cwd. */
export interface WorkspaceAdmissionPort {
  verify(spec: SessionSpecV2): Promise<{ canonicalCwd: string }>;
  withAdmission<T>(spec: SessionSpecV2, action: (verified: { canonicalCwd: string }) => Promise<T>): Promise<T>;
}

/** Target-local owner; read-only sidecar queries never start an adapter or touch the worktree. */
export class AgentHostTargetService {
  readonly #root: string;
  readonly #target: ExecutionTarget;
  readonly #catalog: ModelCatalogPort;
  readonly #registry: HarnessRegistry;
  readonly #admission: WorkspaceAdmissionPort;
  readonly #hosts = new Map<string, SessionHost>();
  readonly #owners = new Map<string, string>();
  readonly #listeners = new Set<(result: TargetHostEvent) => void>();

  constructor(options: {
    root: string;
    target: ExecutionTarget;
    catalog: ModelCatalogPort;
    registry: HarnessRegistry;
    admission: WorkspaceAdmissionPort;
  }) {
    this.#root = options.root;
    this.#target = options.target;
    this.#catalog = options.catalog;
    this.#registry = options.registry;
    this.#admission = options.admission;
  }

  async getAvailability(): Promise<{ target: ExecutionTarget; harnesses: string[] }> {
    return { target: this.#target, harnesses: this.#registry.manifests().map((manifest) => manifest.id) };
  }
  async catalogForTarget(targetId: string): Promise<readonly HarnessCatalogEntry[]> {
    if (targetId !== this.#target.id) throw new Error("foreign target catalog");
    return Promise.all(this.#registry.manifests().map(async (manifest) => {
      const probe = await this.#registry.require(manifest.id).probe(this.#target);
      return { manifest, availability: probe.support, ...(probe.support !== "supported" ? { reason: probe.reason ?? "adapter unavailable" } : {}) };
    }));
  }
  async getSessionCapabilities(raw: SessionSpecV2 | LegacySessionSpec): Promise<HarnessCapabilitiesV2> {
    const spec = this.#readScope(raw);
    const stored = (await SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id }))
      .find((record) => record.spec.hostSessionId === spec.hostSessionId && JSON.stringify(record.spec) === JSON.stringify(spec));
    const unsupported = { support: "unsupported" as const, reason: "history only: session target or backend is not verified" };
    const supported = { support: "supported" as const };
    const history = stored?.state !== "creating" ? supported : unsupported;
    const historyOnly: HarnessCapabilitiesV2 = {
      text: unsupported, tools: unsupported, approvals: unsupported, cancelTurn: unsupported,
      resumeExecution: unsupported, history, images: unsupported, modelSwitch: unsupported,
      detach: unsupported, terminateSession: unsupported, viewHistory: history,
      hostManagedModel: unsupported, fork: unsupported, subagents: unsupported,
    };
    if (!stored || stored.state !== "running" || spec.schemaVersion !== 2 || !this.#target.available) return historyOnly;
    try { await this.#verify(spec); } catch { return historyOnly; }
    const manifest = this.#registry.manifest(spec.harness.id);
    if (!manifest || manifest.adapterVersion !== spec.harness.adapterVersion) return historyOnly;
    const adapter = this.#registry.require(spec.harness.id);
    const probe = await adapter.probe(this.#target);
    if (probe.support !== "supported") return historyOnly;
    const report = await adapter.capabilities(this.#target);
    const notImplemented = { support: "unsupported" as const, reason: "not implemented by Host V4 projection" };
    const unverified = { support: "unknown" as const, reason: "adapter operation not certified" };
    const model = spec.modelBinding.kind === "host-managed"
      ? this.#catalog.validateSelection(spec.modelBinding.selection)
      : { ok: false as const, reason: "harness-managed model" };
    const hostManagedModel = model.ok && spec.modelBinding.kind === "host-managed"
      ? await adapter.hostManagedSupport(this.#target, spec.modelBinding.selection)
      : { support: "unsupported" as const, reason: model.ok ? "unselected model" : model.reason };
    return harnessCapabilitiesV2Schema.parse({
      ...report, history, viewHistory: history, detach: supported,
      // V4 external transport cannot promise operations not implemented at Host admission.
      images: notImplemented, modelSwitch: notImplemented, resumeExecution: notImplemented,
      terminateSession: "terminateSession" in report ? report.terminateSession : unverified,
      hostManagedModel, fork: notImplemented, subagents: notImplemented,
    });
  }
  async getRuntimeActivity(workspaceId: string): Promise<{ running: number; waiting: number; uncertain: number }> {
    const records = await this.listWorkspaceSessions(workspaceId);
    const counts = { running: 0, waiting: 0, uncertain: 0 };
    for (const record of records) {
      if (record.state === "terminated") continue;
      const host = this.#hosts.get(this.#key(record.spec));
      // 离线/重启后 manifest 的 running 不能当空闲，删除必须 fail closed。
      const activity = host?.getActivity() ?? "uncertain";
      if (activity !== "idle") counts[activity]++;
    }
    return counts;
  }
  async listSessions(workspaceIdentity: string, worktreePath: string): Promise<StoredAgentSessionSummary[]> {
    return SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id, workspaceIdentity, worktreePath });
  }
  async listWorkspaceSessions(workspaceId: string): Promise<StoredAgentSessionSummary[]> {
    return SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id, workspaceId });
  }
  async getSessionSpec(scope: { targetId: string; workspaceId: string; hostSessionId: string }): Promise<SessionSpecV2 | undefined> {
    if (scope.targetId !== this.#target.id) return undefined;
    const matches = (await this.listWorkspaceSessions(scope.workspaceId)).filter((record) => record.spec.hostSessionId === scope.hostSessionId);
    if (matches.length > 1) throw new Error("duplicate host session ID in index");
    const spec = matches[0]?.spec;
    return spec?.schemaVersion === 2 ? spec : undefined;
  }
  async create(raw: SessionSpecV2): Promise<ConversationSnapshot> {
    const spec = writableSessionSpecV2Schema.parse(raw);
    return this.#admit(spec, async (key) => {
      if (this.#hosts.has(key)) throw new Error("duplicate external session owner");
      if ((await SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id })).some((record) => record.spec.hostSessionId === spec.hostSessionId))
        throw new Error("duplicate host session ID in index");
      const host = await SessionHost.create({ root: this.#root, spec, target: this.#target, catalog: this.#catalog, registry: this.#registry });
      this.#mount(key, host);
      return host.snapshot();
    });
  }
  async attach(raw: SessionSpecV2): Promise<ConversationSnapshot> {
    const spec = writableSessionSpecV2Schema.parse(raw);
    return this.#admit(spec, async (key) => {
      const mounted = this.#hosts.get(key);
      if (mounted) { await mounted.whenEventsRecorded(); return mounted.snapshot(); }
      const host = await SessionHost.open({ root: this.#root, spec, target: this.#target, catalog: this.#catalog, registry: this.#registry });
      this.#mount(key, host);
      return host.snapshot();
    });
  }
  async dispatch(raw: SessionSpecV2, command: AgentCommand): Promise<AgentCommandReceipt> {
    const spec = writableSessionSpecV2Schema.parse(raw);
    if (command.type === "send" || command.type === "resumeExecution")
      return this.#admit(spec, (key) => this.#require(key).dispatch(command));
    if (command.type === "detach" || command.type === "viewHistory" || command.type === "terminateSession") {
      this.#readScope(spec);
      const stored = await SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id });
      if (!stored.some((row) => JSON.stringify(row.spec) === JSON.stringify(spec))) throw new Error("session identity or configuration mismatch");
      return this.#require(this.#key(spec)).dispatch(command);
    }
    const key = await this.#verify(spec);
    return this.#require(key).dispatch(command);
  }
  async snapshot(raw: SessionSpecV2 | LegacySessionSpec): Promise<ConversationSnapshot> {
    const spec = this.#readScope(raw);
    const host = spec.schemaVersion === 2 ? this.#hosts.get(this.#key(spec)) : undefined;
    if (!host) return SessionHost.snapshotHistory(this.#root, spec);
    await host.whenEventsRecorded();
    return host.snapshot();
  }
  async rowsRange(raw: SessionSpecV2 | LegacySessionSpec, request: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
    const spec = this.#readScope(raw);
    const host = spec.schemaVersion === 2 ? this.#hosts.get(this.#key(spec)) : undefined;
    if (!host) return SessionHost.rowsRangeHistory(this.#root, spec, request);
    await host.whenEventsRecorded();
    return host.rowsRange(request);
  }
  async eventsSince(raw: SessionSpecV2 | LegacySessionSpec, sequence: number): Promise<readonly AgentEvent[]> {
    const spec = this.#readScope(raw);
    const host = spec.schemaVersion === 2 ? this.#hosts.get(this.#key(spec)) : undefined;
    if (!host) return SessionHost.eventsSinceHistory(this.#root, spec, sequence);
    await host.whenEventsRecorded();
    return host.eventsSince(sequence);
  }
  async queryCommand(raw: SessionSpecV2 | LegacySessionSpec, commandId: string): Promise<AgentCommandReceipt | undefined> {
    const spec = this.#readScope(raw);
    const host = spec.schemaVersion === 2 ? this.#hosts.get(this.#key(spec)) : undefined;
    return host ? host.queryCommand(commandId) : SessionHost.queryCommandHistory(this.#root, spec, commandId);
  }
  async waitForIdle(spec: SessionSpecV2): Promise<ConversationSnapshot> {
    const key = await this.#verify(writableSessionSpecV2Schema.parse(spec));
    const host = this.#require(key);
    await host.whenIdle();
    return host.snapshot();
  }
  subscribe(listener: (result: TargetHostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async close(): Promise<void> {
    for (const harness of this.#registry.list()) await harness.shutdown?.();
    for (const host of this.#hosts.values()) {
      await host.whenIdleAllowingGap();
      await host.close();
    }
    this.#hosts.clear();
    this.#owners.clear();
    this.#listeners.clear();
  }

  #mount(key: string, host: SessionHost): void {
    this.#hosts.set(key, host);
    this.#owners.set(host.spec.hostSessionId, key);
    host.subscribe((event) => {
      for (const listener of this.#listeners) listener({ spec: host.spec, event });
    });
  }
  #require(key: string): SessionHost {
    const host = this.#hosts.get(key);
    if (!host) throw new Error("external session is not attached; query history or explicitly attach first");
    return host;
  }
  #readScope(raw: SessionSpecV2 | LegacySessionSpec): SessionSpecV2 | LegacySessionSpec {
    const spec = readableSessionSpecSchema.parse(raw);
    if (spec.execution.targetId !== this.#target.id) throw new Error("foreign history target");
    const owner = this.#owners.get(spec.hostSessionId);
    if (owner && owner !== this.#key(spec)) throw new Error("host session ID belongs to another workspace");
    const mounted = this.#hosts.get(this.#key(spec));
    if (mounted && JSON.stringify(mounted.spec) !== JSON.stringify(spec)) throw new Error("session identity or configuration mismatch");
    return spec;
  }
  #key(spec: SessionSpecV2 | LegacySessionSpec): string {
    return JSON.stringify([spec.execution.targetId, spec.execution.workspaceIdentity, spec.harness.id, spec.hostSessionId]);
  }
  async #admit<T>(spec: SessionSpecV2, action: (key: string) => Promise<T>): Promise<T> {
    this.#assertTarget(spec);
    return this.#admission.withAdmission(spec, async ({ canonicalCwd }) => {
      if (!canonicalCwd) throw new Error("unverified canonical cwd");
      const key = this.#key(spec);
      const mounted = this.#hosts.get(key);
      if (mounted && JSON.stringify(mounted.spec) !== JSON.stringify(spec)) throw new Error("session identity or configuration mismatch");
      return action(key);
    });
  }
  async #verify(spec: SessionSpecV2): Promise<string> {
    this.#assertTarget(spec);
    if (!(await this.#admission.verify(spec)).canonicalCwd) throw new Error("unverified canonical cwd");
    const key = this.#key(spec);
    const owner = this.#owners.get(spec.hostSessionId);
    if (owner && owner !== key) throw new Error("host session ID belongs to another workspace");
    const mounted = this.#hosts.get(key);
    if (mounted && JSON.stringify(mounted.spec) !== JSON.stringify(spec)) throw new Error("session identity or configuration mismatch");
    return key;
  }
  #assertTarget(spec: SessionSpecV2): void {
    if (spec.execution.targetId !== this.#target.id || !this.#target.available || this.#target.platform !== process.platform)
      throw new Error("unauthorized execution target or worktree");
  }
}
