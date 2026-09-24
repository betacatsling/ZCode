/* eslint-disable max-lines -- 单一 Host owner 集中保持 durable admission、事件与摘要写入的顺序。 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  agentCommandReceiptSchema, agentCommandSchema, backendBindingV2Schema, executionTargetSchema,
  frozenTurnModelRouteSchema, readableSessionSpecSchema, writableSessionSpecV2Schema, type AgentCommand, type AgentCommandReceipt, type AgentEvent,
  type BackendBinding, type BackendBindingV2, type BindingPlan, type ExecutionTarget, type LegacySessionSpec, type SessionSpecV2,
  type StoredAgentSessionSummary,
} from "@zcode/shared/agent-host";
import { CommandJournal } from "./commandJournal.js";
import { assertBinding, manifestPath, manifestSchema, matchesScope, readableManifestSchema, saveManifest } from "./sessionManifest.js";
import { EventJournal } from "./eventJournal.js";
import { observeOutcome, publishActivitySummary, readActivitySummary, type ActivitySummary } from "./activityReadModel.js";
import type { HostSessionReadModel } from "./serviceContract.js";
import { HarnessRegistry, type HarnessAdapter } from "./harnessRegistry.js";
import { journalCommittedBytes, journalPath, readJournalLines, type JournalIdentity } from "./journalStorage.js";
import { planModelBinding, type ModelCatalogPort } from "./modelBindingPlanner.js";
import type { V4ConversationRowsRangeParams, V4ConversationRowsRangeResult } from "@zcode/shared/zcode-protocol-v4";
import { v4ConversationRowsRangeParamsSchema, v4ConversationRowsRangeResultSchema } from "@zcode/shared/zcode-protocol-v4";
import { projectHostConversation } from "../agent-ui-projection/projector.js";

export interface SessionHostOptions {
  root: string;
  spec: SessionSpecV2;
  target: ExecutionTarget;
  catalog: ModelCatalogPort;
  registry: HarnessRegistry;
}

/** One target-local owner. Renderer disconnect must NOT call close() on this service. */
export class SessionHost {
  static readonly #coldActivityCache = new Map<string, { signature: string; activity: "uncertain" | "waiting" | "idle" }>();
  readonly spec: SessionSpecV2;
  readonly binding: BackendBindingV2;
  readonly plan: BindingPlan;
  readonly #manifestPath: string;
  readonly #root: string;
  readonly #identity: JournalIdentity;
  #lastOutcome?: ActivitySummary["lastOutcome"];
  #summaryTail: Promise<void> = Promise.resolve();
  readonly #adapter: HarnessAdapter;
  readonly #target: ExecutionTarget;
  readonly #catalog: ModelCatalogPort;
  readonly #commands: CommandJournal;
  readonly #events: EventJournal;
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #active = new Set<Promise<void>>();
  readonly #interactions = new Map<string, { turnId: string; kind: "permission" | "question" }>();
  readonly #pendingTools = new Set<string>();
  #backendUnknown = false;
  #activeTurn?: string;
  #eventTail: Promise<void> = Promise.resolve();
  #dispatchTail: Promise<void> = Promise.resolve();
  #eventError?: Error;
  #unsubscribe: () => void;
  #closed = false;

  private constructor(options: {
    root: string; identity: JournalIdentity; manifestPath: string; spec: SessionSpecV2; plan: BindingPlan; binding: BackendBindingV2;
    adapter: HarnessAdapter; commands: CommandJournal; events: EventJournal; target: ExecutionTarget; catalog: ModelCatalogPort;
  }) {
    this.#manifestPath = options.manifestPath;
    this.#root = options.root;
    this.#identity = options.identity;
    this.spec = options.spec;
    this.plan = options.plan;
    this.binding = options.binding;
    this.#adapter = options.adapter;
    this.#target = options.target;
    this.#catalog = options.catalog;
    this.#commands = options.commands;
    this.#events = options.events;
    for (let sequence = 0; ; ) {
      const batch = this.#events.since(sequence);
      for (const event of batch) this.#applyEventState(event);
      sequence += batch.length;
      if (batch.length < 500) break;
    }
    this.#unsubscribe = options.adapter.subscribe(options.spec.hostSessionId, (source) => {
      this.#eventTail = this.#eventTail.then(async () => {
        if (this.#eventError) return;
        const { event, appended } = await this.#events.appendWithStatus(source);
        if (!appended) return;
        this.#applyEventState(event);
        await this.#publishSummary();
        for (const listener of this.#listeners) listener(event);
      }).catch(async (error: unknown) => {
        this.#eventError = error instanceof Error ? error : new Error(String(error));
        await this.#publishSummary();
      });
    });
  }

  static async create(options: SessionHostOptions): Promise<SessionHost> {
    const spec = writableSessionSpecV2Schema.parse(options.spec);
    const target = executionTargetSchema.parse(options.target);
    const adapter = options.registry.require(spec.harness.id);
    const plan = await planModelBinding({ spec, target, harness: adapter, catalog: options.catalog });
    if (plan.support.support !== "supported") throw new Error(plan.support.reason ?? "unsupported model binding");
    const path = manifestPath(options.root, spec);
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    // 修复跨 Harness/工作区相同 hostSessionId 被复用：先持久保留全 target 的唯一 ID。
    const reservation = await open(join(options.root, `${createHash("sha256").update(spec.hostSessionId).digest("hex")}.owner.json`), "wx", 0o600);
    try { await reservation.writeFile(JSON.stringify({ schemaVersion: 2, targetId: spec.execution.targetId, workspaceId: spec.workspaceId, hostSessionId: spec.hostSessionId })); await reservation.sync(); }
    finally { await reservation.close(); }
    // Mark an in-flight create before backend launch. Crash at this point is unknown, not retried.
    const handle = await open(path, "wx", 0o600);
    try {
      const initial = manifestSchema.parse({ schemaVersion: 2, state: "creating", spec, plan });
      await handle.writeFile(JSON.stringify(initial));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const binding = backendBindingV2Schema.parse(await adapter.create(spec, plan));
    assertBinding(spec, binding, adapter);
    await saveManifest(path, { schemaVersion: 2, state: "running", spec, plan, binding });
    return SessionHost.#mount(options.root, path, spec, plan, binding, adapter, target, options.catalog);
  }

  static async open(options: SessionHostOptions): Promise<SessionHost> {
    const spec = writableSessionSpecV2Schema.parse(options.spec);
    const path = manifestPath(options.root, spec);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (!matchesScope(manifest, spec)) throw new Error("session identity or configuration mismatch");
    if (!manifest.binding || manifest.state === "creating") throw new Error("execution-unknown: backend create was not confirmed");
    if (manifest.state === "terminated") throw new Error("terminated session is history-only; never restart its backend");
    const adapter = options.registry.require(spec.harness.id);
    assertBinding(spec, manifest.binding, adapter);
    const host = await SessionHost.#mount(options.root, path, spec, manifest.plan, manifest.binding, adapter, options.target, options.catalog);
    try { await adapter.attach(spec, manifest.binding, host.snapshot().seq, manifest.plan); } catch (error) { await host.close(); throw error; }
    return host;
  }

  /** Read-only recovery path: does not load an adapter, call a Provider or start a worker. */
  static async snapshotHistory(root: string, spec: LegacySessionSpec | SessionSpecV2) {
    const { binding, identity } = await SessionHost.#storedHistory(root, spec);
    const events = await EventJournal.readHistory(root, identity);
    return projectHostConversation({ spec, runtimeEpoch: binding.runtimeEpoch, events });
  }

  static async eventsSinceHistory(root: string, spec: LegacySessionSpec | SessionSpecV2, sequence: number): Promise<readonly AgentEvent[]> {
    const { identity } = await SessionHost.#storedHistory(root, spec);
    return EventJournal.sinceHistory(root, identity, sequence);
  }

  static async queryCommandHistory(root: string, spec: LegacySessionSpec | SessionSpecV2, commandId: string): Promise<AgentCommandReceipt | undefined> {
    const { identity } = await SessionHost.#storedHistory(root, spec);
    return CommandJournal.queryHistory(root, identity, commandId);
  }

  /** Target-local sidecar index; never inserts external sessions into native CLI storage. */
  static async listStoredSessions(root: string, input: {
    targetId: string; workspaceIdentity?: string; worktreePath?: string; workspaceId?: string;
  }): Promise<StoredAgentSessionSummary[]> {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: StoredAgentSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".session.json")) continue;
      const path = join(root, entry.name);
      const metadata = await stat(path);
      if (metadata.size > 128 * 1024) throw new Error("oversized external session manifest; manual inspection required");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const parsed = readableManifestSchema.safeParse(value);
      if (!parsed.success) throw new Error("unreadable or future external session manifest; refusing to hide history");
      const manifest = parsed.data;
      if (manifest.spec.execution.targetId !== input.targetId ||
          (input.workspaceIdentity !== undefined && manifest.spec.execution.workspaceIdentity !== input.workspaceIdentity) ||
          (input.worktreePath !== undefined && manifest.spec.execution.worktreePath !== input.worktreePath) ||
          (input.workspaceId !== undefined && (manifest.schemaVersion !== 2 || manifest.spec.workspaceId !== input.workspaceId))) continue;
      summaries.push({ spec: manifest.spec, state: manifest.state, updatedAt: metadata.mtimeMs });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static async readModelHistory(root: string, spec: LegacySessionSpec | SessionSpecV2): Promise<HostSessionReadModel> {
    let stored;
    try { stored = await SessionHost.#storedHistory(root, spec); }
    catch (error) {
      if (error instanceof Error && error.message.includes("backend create was not confirmed"))
        return { runtimeEpoch: null, seq: 0, activity: "uncertain" };
      throw error;
    }
    const summary = await readActivitySummary(root, stored.identity);
    if (!summary) return { runtimeEpoch: stored.binding.runtimeEpoch, seq: 0, activity: "uncertain" };
    return { runtimeEpoch: summary.runtimeEpoch, seq: summary.seq,
      activity: summary.pendingSend || summary.activity === "running" ? "uncertain" : summary.activity,
      ...(summary.lastOutcome ? { lastOutcome: summary.lastOutcome } : {}) };
  }


  static async historyActivity(root: string, spec: LegacySessionSpec | SessionSpecV2): Promise<"uncertain" | "waiting" | "idle"> {
    let stored;
    try { stored = await SessionHost.#storedHistory(root, spec); }
    catch (error) {
      if (error instanceof Error && error.message.includes("backend create was not confirmed")) return "uncertain";
      throw error;
    }
    const { identity } = stored;
    const summary = await readActivitySummary(root, identity);
    if (summary) return summary.pendingSend || summary.activity === "running" ? "uncertain" : summary.activity;
    const paths = [journalPath(root, identity, "events"), journalPath(root, identity, "commands")];
    const readSignature = async () => JSON.stringify(await Promise.all(paths.map(async (path) => {
      try { const metadata = await stat(path); return [metadata.size, metadata.mtimeMs, metadata.ctimeMs, await journalCommittedBytes(path)]; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    })));
    const signature = await readSignature();
    const cacheKey = JSON.stringify([root, identity]);
    const cached = SessionHost.#coldActivityCache.get(cacheKey);
    if (cached?.signature === signature) return cached.activity;
    if (await CommandJournal.hasUnresolvedHistory(root, identity)) {
      if (await readSignature() !== signature) return "uncertain";
      SessionHost.#coldActivityCache.set(cacheKey, { signature, activity: "uncertain" });
      return "uncertain";
    }

    const events = await EventJournal.readHistory(root, identity);
    const activeTurns = new Set<string>();
    const pendingInteractions = new Map<string, string>();
    const pendingTools = new Map<string, string>();
    let backendUnknown = false;
    for (const event of events) {
      if (event.kind === "turn.started") activeTurns.add(event.turnId);
      if (event.kind === "turn.finished") {
        activeTurns.delete(event.turnId);
        for (const [id, turnId] of pendingInteractions) if (turnId === event.turnId) pendingInteractions.delete(id);
        for (const [id, turnId] of pendingTools) if (turnId === event.turnId) pendingTools.delete(id);
        if (event.outcome === "unknown") backendUnknown = true;
      }
      if (event.kind === "interaction.requested" || event.kind === "question.requested") pendingInteractions.set(event.interactionId, event.turnId);
      if (event.kind === "interaction.resolved" || event.kind === "question.answered") pendingInteractions.delete(event.interactionId);
      if (event.kind === "tool.started") pendingTools.set(event.toolCallId, event.turnId);
      if (event.kind === "tool.finished") pendingTools.delete(event.toolCallId);
      if (event.kind === "session.status" && (event.state === "execution-unknown" || event.state === "interrupted")) backendUnknown = true;
      if (event.kind === "session.status" && event.state === "idle") backendUnknown = false;
    }
    const activity = backendUnknown || activeTurns.size || pendingTools.size ? "uncertain" : pendingInteractions.size ? "waiting" : "idle";
    if (await readSignature() !== signature) return "uncertain"; // 修复回放期间追加事件时缓存旧空闲于新水位。
    SessionHost.#coldActivityCache.set(cacheKey, { signature, activity });
    return activity;

  }

  static async rowsRangeHistory(root: string, spec: LegacySessionSpec | SessionSpecV2, request: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
    const params = v4ConversationRowsRangeParamsSchema.parse(request);
    if (params.sessionId !== spec.hostSessionId) throw new Error("foreign rows session");
    const { binding, identity } = await SessionHost.#storedHistory(root, spec);
    // 修复两次读取事件日志之间追加事件导致水位与返回行不一致：只投影同一提交视图。
    const events = await EventJournal.readHistory(root, identity);
    const snapshot = projectHostConversation({ spec, runtimeEpoch: binding.runtimeEpoch, events, rowRange: params });
    return SessionHost.#rangeResult(snapshot, params);
  }

  static async #storedHistory(root: string, raw: LegacySessionSpec | SessionSpecV2): Promise<{ binding: BackendBinding; identity: JournalIdentity }> {
    const spec = readableSessionSpecSchema.parse(raw);
    const manifest = readableManifestSchema.parse(JSON.parse(await readFile(manifestPath(root, spec), "utf8")));
    if (!matchesScope(manifest, spec)) throw new Error("session identity or configuration mismatch");
    if (!manifest.binding) throw new Error("execution-unknown: backend create was not confirmed");
    return {
      binding: manifest.binding,
      identity: {
        targetId: spec.execution.targetId, workspaceIdentity: spec.execution.workspaceIdentity,
        harnessId: spec.harness.id, hostSessionId: spec.hostSessionId,
        runtimeEpoch: manifest.binding.runtimeEpoch,
      },
    };
  }

  static async #mount(root: string, path: string, spec: SessionSpecV2, plan: BindingPlan, binding: BackendBindingV2, adapter: HarnessAdapter, target: ExecutionTarget, catalog: ModelCatalogPort): Promise<SessionHost> {
    const identity: JournalIdentity = {
      targetId: spec.execution.targetId,
      workspaceIdentity: spec.execution.workspaceIdentity,
      harnessId: spec.harness.id,
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: binding.runtimeEpoch,
    };
    const events = await EventJournal.open(root, identity);
    try {
      const commands = await CommandJournal.open(root, identity);
      const host = new SessionHost({ root, identity, manifestPath: path, spec, plan, binding, adapter, commands, events, target, catalog });
      await host.#publishSummary();
      return host;
    } catch (error) { await events.close(); throw error; }
  }

  async dispatch(raw: AgentCommand): Promise<AgentCommandReceipt> {
    // 同一个 Host 是唯一命令 admission owner：并发 send 必须串行检查 activeTurn。
    const run = this.#dispatchTail.then(() => this.#dispatch(raw));
    this.#dispatchTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #dispatch(raw: AgentCommand): Promise<AgentCommandReceipt> {
    if (this.#closed) throw new Error("session host closed");
    const command = agentCommandSchema.parse(raw);
    if (command.hostSessionId !== this.spec.hostSessionId) throw new Error("foreign session command");
    const receipt = await this.#commands.accept(command);
    if (receipt.status === "duplicate") return receipt;
    await this.#publishSummary();
    await this.#eventTail;
    if (this.#closed) return this.#reject(command, "backend-failure", "session host is closing");
    if (this.#eventError && !["viewHistory", "detach", "terminateSession"].includes(command.type))
      return this.#reject(command, "execution-unknown", "event gap requires backend resync; history remains readable");
    if (command.type === "send") {
      if (this.#commands.hasUncertainSend()) {
        return this.#reject(command, "execution-unknown", "previous prompt may have executed; inspect history before explicit recovery");
      }
      if (this.#activeTurn) return this.#reject(command, "unsupported", "session busy");
      this.#activeTurn = command.turnId;
      try {
        const plan = await planModelBinding({ spec: this.spec, target: this.#target, harness: this.#adapter, catalog: this.#catalog });
        if (plan.support.support !== "supported" || plan.capabilities.text?.support !== "supported") {
          this.#activeTurn = undefined;
          return this.#reject(command, "unsupported", plan.support.reason ?? plan.capabilities.text?.reason ?? "text unavailable");
        }
        if (plan.requested.kind === "host-managed" && !this.#adapter.prepareTurn && plan.route !== "mock") {
          this.#activeTurn = undefined;
          return this.#reject(command, "unsupported", "adapter cannot freeze the selected model before dispatch");
        }
        const route = frozenTurnModelRouteSchema.parse({
          schemaVersion: 1, hostSessionId: this.spec.hostSessionId, turnId: command.turnId,
          runtimeEpoch: this.binding.runtimeEpoch, targetId: this.spec.execution.targetId,
          workspaceId: this.spec.workspaceId, harnessId: this.spec.harness.id,
          adapterVersion: plan.adapterVersion, catalogFingerprint: plan.catalogFingerprint,
          requested: plan.requested, effective: plan.effective, route: plan.route, credentialRef: plan.credentialRef,
        });
        await this.#commands.freezeTurn(command.commandId, route);
        await this.#publishSummary();
        await this.#adapter.prepareTurn?.(this.spec, { turnId: command.turnId, runtimeEpoch: this.binding.runtimeEpoch, plan });
        const run = this.#adapter.send(command);
        this.#track(command.commandId, command.turnId, run);
        return receipt;
      } catch (error) {
        this.#activeTurn = undefined;
        // 准备阶段可能已分配后端资源；不可在未知副作用后将同一命令重发。
        await this.#commands.finish(command.commandId, { commandId: command.commandId, status: "execution-unknown", reasonCode: "execution-unknown" });
        await this.#publishSummary();
        return { commandId: command.commandId, status: "execution-unknown", reasonCode: "execution-unknown", message: error instanceof Error ? error.message : "backend failed" };
      }
    }
    try {
      switch (command.type) {
        case "cancelTurn":
          if (!this.#isCurrentTurn(command)) return this.#reject(command, "stale-turn", "turn or epoch changed");
          if ((await this.#adapter.capabilities(this.#target)).cancelTurn.support !== "supported")
            return this.#reject(command, "unsupported", "cancel unavailable");
          await this.#adapter.cancelTurn(command);
          break;
        case "resolveInteraction":
          if (!this.#isCurrentTurn(command) || this.#interactions.get(command.interactionId)?.turnId !== command.turnId || this.#interactions.get(command.interactionId)?.kind !== "permission") {
            return this.#reject(command, "stale-interaction", "interaction or epoch changed");
          }
          if ((await this.#adapter.capabilities(this.#target)).approvals.support !== "supported")
            return this.#reject(command, "unsupported", "approvals unavailable");
          await this.#adapter.resolveInteraction(command);
          break;
        case "answerInteraction": {
          if (!this.#isCurrentTurn(command) || this.#interactions.get(command.interactionId)?.turnId !== command.turnId || this.#interactions.get(command.interactionId)?.kind !== "question")
            return this.#reject(command, "stale-interaction", "question or epoch changed");
          const capabilities = await this.#adapter.capabilities(this.#target);
          if (!("questions" in capabilities) || capabilities.questions?.support !== "supported" || !this.#adapter.answerInteraction)
            return this.#reject(command, "unsupported", "native question answering is not available");
          // 修复源事件延迟时第二个 commandId 再次投递答案：首次 durable accept 即是预留，
          // 必须先读提交游标内的命令记录；崩溃后未确认的预留也不能被当成安全重试。
          if (await this.#questionAlreadyReserved(command)) {
            const unknown: AgentCommandReceipt = { commandId: command.commandId, status: "execution-unknown", reasonCode: "execution-unknown" };
            await this.#commands.finish(command.commandId, unknown);
            await this.#publishSummary();
            return unknown;
          }
          // 修复能力探测/日志读取期间源事件已解决问题仍投递旧答案：交付前再消费事件尾并校验。
          await this.#eventTail;
          if (this.#eventError) {
            const unknown: AgentCommandReceipt = { commandId: command.commandId, status: "execution-unknown", reasonCode: "execution-unknown" };
            await this.#commands.finish(command.commandId, unknown);
            await this.#publishSummary();
            return unknown;
          }
          if (!this.#isCurrentTurn(command) || this.#interactions.get(command.interactionId)?.kind !== "question" ||
              this.#interactions.get(command.interactionId)?.turnId !== command.turnId)
            return this.#reject(command, "stale-interaction", "question or epoch changed before delivery");
          await this.#adapter.answerInteraction(command);
          break;
        }
        case "detach": // Closing a UI subscription never touches the target worker.
        case "viewHistory":
          break;
        case "terminateSession": {
          const capabilities = await this.#adapter.capabilities(this.#target);
          if (!("terminateSession" in capabilities) || capabilities.terminateSession.support !== "supported")
            return this.#reject(command, "unsupported", "termination is not certified");
          await this.#adapter.terminate(this.spec.hostSessionId);
          await saveManifest(this.#manifestPath, { schemaVersion: 2, state: "terminated", spec: this.spec, plan: this.plan, binding: this.binding });
          break;
        }
        case "resumeExecution":
          return this.#reject(command, "unsupported", "backend native resume is not implemented");
        case "createSession":
          return this.#reject(command, "duplicate-id", "session already created");
      }
      const done: AgentCommandReceipt = { commandId: command.commandId, status: "completed" };
      await this.#commands.finish(command.commandId, done);
      await this.#publishSummary();
      return done;
    } catch (error) {
      if (command.type === "answerInteraction") {
        // 修复后端已接收答案但宿主未确认的窗口：不能声称安全拒绝、更不能自动重试。
        const unknown: AgentCommandReceipt = { commandId: command.commandId, status: "execution-unknown", reasonCode: "execution-unknown" };
        await this.#commands.finish(command.commandId, unknown);
        await this.#publishSummary();
        return unknown;
      }
      return this.#reject(command, "backend-failure", error instanceof Error ? error.message : "backend failed");
    }
  }

  /** Committed answer admissions are the reservation; rejected pre-delivery commands release theirs. */
  async #questionAlreadyReserved(command: Extract<AgentCommand, { type: "answerInteraction" }>): Promise<boolean> {
    const lines = await readJournalLines(journalPath(this.#root, this.#identity, "commands"));
    const earlier = new Map<string, AgentCommandReceipt>();
    let reachedCurrent = false;
    for (const line of lines) {
      const raw: unknown = JSON.parse(line);
      if (typeof raw !== "object" || raw === null) throw new Error("invalid question reservation record");
      if (!("receipt" in raw)) {
        // 修复损坏的已提交记录被误跳过而允许第二次投递；仅有效的 send 路由可跳过。
        if (!("frozenRoute" in raw) || !("command" in raw) || typeof raw.command !== "string" ||
            frozenTurnModelRouteSchema.safeParse(raw.frozenRoute).success === false)
          throw new Error("invalid question reservation record");
        continue;
      }
      const { command: recorded, receipt: result } = raw as { command: unknown; receipt: unknown };
      const previous = agentCommandSchema.parse(recorded);
      const receipt = agentCommandReceiptSchema.parse(result);
      if (previous.hostSessionId !== this.spec.hostSessionId || receipt.commandId !== previous.commandId)
        throw new Error("foreign question reservation record");
      if (previous.commandId === command.commandId) { reachedCurrent = true; continue; }
      if (previous.type === "answerInteraction" && previous.runtimeEpoch === command.runtimeEpoch &&
          previous.turnId === command.turnId && previous.interactionId === command.interactionId)
        earlier.set(previous.commandId, receipt);
    }
    if (!reachedCurrent) throw new Error("missing durable question admission");
    return [...earlier.values()].some((receipt) => receipt.status !== "rejected");
  }

  getReadModel(): HostSessionReadModel {
    return { runtimeEpoch: this.binding.runtimeEpoch, seq: this.#events.length, activity: this.getActivity(),
      ...(this.#lastOutcome ? { lastOutcome: this.#lastOutcome } : {}) };
  }
  getActivity(): "running" | "waiting" | "uncertain" | "idle" {
    if (this.#eventError || this.#backendUnknown || this.#commands.hasUncertainSend()) return "uncertain";
    if (this.#interactions.size) return "waiting";
    return this.#activeTurn || this.#pendingTools.size || this.#commands.hasPendingSend() ? "running" : "idle";

  }
  rowsRange(request: V4ConversationRowsRangeParams): V4ConversationRowsRangeResult {
    const params = v4ConversationRowsRangeParamsSchema.parse(request);
    if (params.sessionId !== this.spec.hostSessionId) throw new Error("foreign rows session");
    const snapshot = projectHostConversation({ spec: this.spec, runtimeEpoch: this.binding.runtimeEpoch,
      events: this.#allEvents(), rowRange: params });
    return SessionHost.#rangeResult(snapshot, params);
  }
  eventsSince(sequence: number): readonly AgentEvent[] { return this.#events.since(sequence); }
  snapshot() {
    return projectHostConversation({ spec: this.spec, runtimeEpoch: this.binding.runtimeEpoch, events: this.#allEvents() });
  }
  #allEvents(): AgentEvent[] {
    const events: AgentEvent[] = [];
    while (true) { const batch = this.#events.since(events.length); events.push(...batch); if (batch.length < 500) break; }
    return events;
  }
  static #rangeResult(snapshot: ReturnType<typeof projectHostConversation>, params: V4ConversationRowsRangeParams): V4ConversationRowsRangeResult {
    const eligible = Math.min(snapshot.rows.totalCount, Math.max(0, Math.ceil(params.beforeRowId ?? Infinity) - 1));
    return v4ConversationRowsRangeResultSchema.parse({ rows: snapshot.rows.window, atSeq: snapshot.seq,
      atRevision: snapshot.revision, atLogEpoch: snapshot.logEpoch, hasMore: eligible > snapshot.rows.window.length });
  }
  queryCommand(commandId: string): AgentCommandReceipt | undefined { return this.#commands.query(commandId); }
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async whenEventsRecorded(): Promise<void> { await this.#eventTail; }
  async whenEventsSettled(): Promise<void> {
    await this.whenEventsRecorded();
    if (this.#eventError) throw this.#eventError;
  }
  async whenIdleAllowingGap(): Promise<void> {
    await Promise.all(this.#active);
    await this.whenEventsRecorded();
  }
  async whenIdle(): Promise<void> {
    await this.whenIdleAllowingGap();
    if (this.#eventError) throw this.#eventError;
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#active.size) throw new Error("active turn: detach a client, cancel the turn or terminate the session before closing the host");
    await this.whenIdleAllowingGap();
    this.#closed = true;
    this.#unsubscribe();
    await this.#commands.close();
    await this.#events.close();
  }

  #track(commandId: string, turnId: string, run: Promise<void>): void {
    const tracked = run.then(async () => {
      await this.#eventTail;
      if (this.#eventError || this.#activeTurn === turnId) {
        await this.#commands.finish(commandId, { commandId, status: "execution-unknown", reasonCode: "execution-unknown" });
      } else {
        await this.#commands.finish(commandId, { commandId, status: "completed" });
      }
      await this.#publishSummary();
    }, async () => {
      await this.#eventTail;
      await this.#commands.finish(commandId, { commandId, status: "execution-unknown", reasonCode: "execution-unknown" });
      await this.#publishSummary();
    });
    this.#active.add(tracked);
    void tracked.then(() => this.#active.delete(tracked), () => this.#active.delete(tracked));
  }
  #isCurrentTurn(command: { runtimeEpoch: string; turnId: string }): boolean {
    return command.runtimeEpoch === this.binding.runtimeEpoch && command.turnId === this.#activeTurn;
  }
  #applyEventState(event: AgentEvent): void {
    this.#lastOutcome = observeOutcome(this.#lastOutcome, event);
    if (event.kind === "turn.started") this.#activeTurn = event.turnId;
    if (event.kind === "tool.started") this.#pendingTools.add(event.toolCallId);
    if (event.kind === "tool.finished") this.#pendingTools.delete(event.toolCallId);
    if (event.kind === "session.status" && (event.state === "execution-unknown" || event.state === "interrupted")) this.#backendUnknown = true;
    if (event.kind === "session.status" && event.state === "idle") this.#backendUnknown = false;
    if (event.kind === "interaction.requested" || event.kind === "question.requested") {
      if (!this.#activeTurn || this.#activeTurn !== event.turnId || this.#interactions.has(event.interactionId))
        throw new Error("stale or duplicate interaction source event");
      this.#interactions.set(event.interactionId, { turnId: event.turnId, kind: event.kind === "interaction.requested" ? "permission" : "question" });
    }
    if (event.kind === "interaction.resolved" || event.kind === "question.answered") {
      const pending = this.#interactions.get(event.interactionId);
      if (pending?.turnId !== event.turnId || pending.kind !== (event.kind === "interaction.resolved" ? "permission" : "question"))
        throw new Error("stale or mismatched interaction source resolution");
      this.#interactions.delete(event.interactionId);
    }
    if (event.kind === "turn.finished") {
      if (this.#activeTurn && event.turnId !== this.#activeTurn) throw new Error("out-of-order turn completion");
      this.#activeTurn = undefined;
      this.#interactions.clear();
      this.#pendingTools.clear();
      if (event.outcome === "unknown") this.#backendUnknown = true;
    }
  }
  #publishSummary(): Promise<void> {
    const write = this.#summaryTail.then(() => publishActivitySummary(this.#root, this.#identity, {
      seq: this.#events.length, activity: this.getActivity(), pendingSend: this.#commands.hasPendingSend(),
      ...(this.#lastOutcome ? { lastOutcome: this.#lastOutcome } : {}),
    }));
    this.#summaryTail = write.then(() => undefined, () => undefined);
    return write;
  }
  async #reject(command: AgentCommand, reasonCode: NonNullable<AgentCommandReceipt["reasonCode"]>, message: string): Promise<AgentCommandReceipt> {
    const receipt: AgentCommandReceipt = { commandId: command.commandId, status: "rejected", reasonCode, message };
    await this.#commands.finish(command.commandId, receipt);
    await this.#publishSummary();
    return receipt;
  }
}
