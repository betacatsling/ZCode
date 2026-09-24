import type { AgentCommand, AgentCommandReceipt, AgentEvent, ExecutionTarget, HarnessCatalogEntry, HarnessCapabilitiesV2, LegacySessionSpec, SessionSpecV2, StoredAgentSessionSummary } from "@zcode/shared/agent-host";
import { harnessCapabilitiesV2Schema, readableSessionSpecSchema, writableSessionSpecV2Schema } from "@zcode/shared/agent-host";
import type { ConversationSnapshot, V4ConversationRowsRangeParams, V4ConversationRowsRangeResult } from "@zcode/shared/zcode-protocol-v4";
import { HarnessRegistry } from "./harnessRegistry.js";
import { CreationJournal, type CreationCommand } from "./creationJournal.js";
import { SessionHost } from "./sessionHost.js";
import type { ModelCatalogPort } from "./modelBindingPlanner.js";
import type { HostSessionReadModel } from "./serviceContract.js";

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
  readonly #creates = new Map<string, { spec: string; result: Promise<ConversationSnapshot> }>();

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
    const history = stored && stored.state !== "creating" ? supported : unsupported;
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
  async getSessionReadModel(raw: SessionSpecV2 | LegacySessionSpec): Promise<HostSessionReadModel> {
    const spec = this.#readScope(raw);
    const host = spec.schemaVersion === 2 ? this.#hosts.get(this.#key(spec)) : undefined;
    if (host) { await host.whenEventsRecorded(); return host.getReadModel(); }
    try { return await SessionHost.readModelHistory(this.#root, spec); }
    catch { return { runtimeEpoch: null, seq: 0, activity: "uncertain" }; } // 损坏记录只可呈现未知，不能暗示空闲。
  }
  async getRuntimeActivity(workspaceId?: string): Promise<{ running: number; waiting: number; uncertain: number }> {
    const records = await SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id, ...(workspaceId === undefined ? {} : { workspaceId }) });
    const counts = { running: 0, waiting: 0, uncertain: 0 };
    const manifestIds = new Set(records.map((record) => record.spec.hostSessionId));
    const pendingCreates = new Set((await CreationJournal.listUnresolved(this.#root, this.#target.id, workspaceId)).map((spec) => spec.hostSessionId));
    for (const id of pendingCreates) if (!manifestIds.has(id)) counts.uncertain++;
    for (const record of records) {
      if (record.state === "terminated") continue;
      const host = this.#hosts.get(this.#key(record.spec));
      // 修复离线历史被一律视为未知：只有未确认创建、未完成命令或未解决的工具门禁才阻止维护。
      let activity: "running" | "waiting" | "uncertain" | "idle";
      try { activity = pendingCreates.has(record.spec.hostSessionId) ? "uncertain" : host?.getActivity() ?? await SessionHost.historyActivity(this.#root, record.spec); }
      catch { activity = "uncertain"; } // 损坏或不完整的只读日志不能被当作空闲以放行维护。
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
  async queryCreationCommand(commandId: string): Promise<CreationCommand | undefined> {
    return CreationJournal.query(this.#root, commandId);
  }
  async create(raw: SessionSpecV2, commandId: string): Promise<ConversationSnapshot> {
    const spec = writableSessionSpecV2Schema.parse(raw);
    const serialized = JSON.stringify(spec);
    const flight = this.#creates.get(commandId);
    if (flight) {
      if (flight.spec !== serialized) throw new Error("creation command ID collision: different session spec");
      return flight.result;
    }
    const result = this.#create(spec, commandId);
    this.#creates.set(commandId, { spec: serialized, result });
    try { return await result; }
    finally { this.#creates.delete(commandId); }
  }
  async #create(spec: SessionSpecV2, commandId: string): Promise<ConversationSnapshot> {
    // 重试先查持久命令；已完成的创建可以只读恢复，不能再次触发 adapter.create。
    const prior = await CreationJournal.query(this.#root, commandId);
    if (prior) return this.#creationResult(spec, prior);
    return this.#admit(spec, async (key) => {
      if (this.#hosts.has(key) || (await SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id })).some((record) => record.spec.hostSessionId === spec.hostSessionId))
        throw new Error("duplicate host session ID in index");
      const existing = await CreationJournal.reserve(this.#root, spec, commandId);
      if (existing) return this.#creationResult(spec, existing);
      const host = await SessionHost.create({ root: this.#root, spec, target: this.#target, catalog: this.#catalog, registry: this.#registry });
      await CreationJournal.finish(this.#root, spec, commandId);
      this.#mount(key, host);
      return host.snapshot();
    });
  }
  async #creationResult(spec: SessionSpecV2, prior: CreationCommand): Promise<ConversationSnapshot> {
    if (JSON.stringify(prior.spec) !== JSON.stringify(spec)) throw new Error("creation command ID collision: different session spec");
    if (prior.receipt.status !== "completed") throw new Error("execution-unknown: creation command may have reached backend; inspect receipt");
    return this.snapshot(spec);
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
    const control = command.type === "detach" || command.type === "viewHistory" || command.type === "terminateSession" ||
      command.type === "cancelTurn" || (command.type === "resolveInteraction" && command.decision === "deny");
    if (control) return this.#dispatchMounted(spec, command);
    // 修复归档后已接受命令的重复投递被新执行门禁阻断：仅已有 ID 可进 Host 的持久 payload 碰撞校验。
    // 查询本身不能成为执行许可；没有 ID 的请求仍须持有 workspace admission lease。
    const mounted = this.#hosts.get(this.#key(spec));
    if (mounted?.queryCommand(command.commandId)) return this.#dispatchMounted(spec, command);
    // allow 可能实际执行工具；与新 send 一样必须持有实时 Git generation/cwd 和归档 admission 门禁直到交付。
    return this.#admit(spec, (key) => this.#require(key).dispatch(command));
  }
  async #dispatchMounted(spec: SessionSpecV2, command: AgentCommand): Promise<AgentCommandReceipt> {
    this.#readScope(spec);
    const stored = await SessionHost.listStoredSessions(this.#root, { targetId: this.#target.id });
    if (!stored.some((row) => JSON.stringify(row.spec) === JSON.stringify(spec))) throw new Error("session identity or configuration mismatch");
    return this.#require(this.#key(spec)).dispatch(command);
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
