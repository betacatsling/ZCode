/* eslint-disable max-lines -- Host lifecycle, history projection and journal ownership stay one state machine. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Model } from "@zcode/contracts";
import {
  agentCommandSchema,
  backendBindingSchema,
  bindingPlanSchema,
  executionTargetSchema,
  agentHostSessionSummarySchema,
  sessionSpecSchema,
  type AgentCommand,
  type AgentCommandReceipt,
  type AgentEvent,
  type AgentHostSessionSummary,
  type BackendBinding,
  type BindingPlan,
  type ExecutionTarget,
  type SessionSpec,
  type StoredAgentSessionSummary,
} from "@zcode/shared/agent-host";
import {
  CommandJournal,
  type CommandAdmissionDecision,
  type TurnBindingAuditFact,
} from "./commandJournal.js";
import { EventJournal } from "./eventJournal.js";
import {
  HarnessRegistry,
  type HarnessAdapter,
  type PreparedHostBinding,
} from "./harnessRegistry.js";
import type { JournalIdentity } from "./journalStorage.js";
import { assertWorkspaceExecution, type WorkspaceSessionOwnership } from "./sessionRouter.js";
import {
  planModelBinding,
  type ModelCatalogPort,
  type ModelCatalogSnapshotPort,
} from "./modelBindingPlanner.js";
import { projectHostConversation } from "../agent-ui-projection/projector.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { AgentHostActivityIndexEntry } from "./activityIndex.js";
import { staleModelBindingError } from "./modelBindingErrors.js";

const logger = createServiceLogger("agent-host-session");

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(["creating", "running", "terminated"]),
  spec: sessionSpecSchema,
  title: z.string().max(256).optional(),
  creationRequest: z
    .strictObject({
      requestId: z.string().trim().min(1).max(256),
      requestFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  plan: bindingPlanSchema,
  binding: backendBindingSchema.optional(),
});
type Manifest = z.infer<typeof manifestSchema>;

const activityIndexEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  spec: sessionSpecSchema,
  runtimeEpoch: z.string().min(1).nullable(),
  sequence: z.number().int().nonnegative(),
  state: z.enum(["idle", "busy", "unknown"]),
  activeTurnId: z.string().min(1).nullable(),
  pendingInteractionIds: z.array(z.string().min(1)).max(128),
});

export interface SessionHostOptions {
  root: string;
  spec: SessionSpec;
  target: ExecutionTarget;
  catalog: ModelCatalogPort;
  registry: HarnessRegistry;
  /** Adopted-workspace admission from the worktree service. Absent only for tests of the host itself. */
  workspaces?: WorkspaceSessionOwnership;
}

interface PreparedTurnContext {
  readonly binding: PreparedHostBinding;
  readonly catalog: ModelCatalogSnapshotPort;
}

/** One target-local owner. Renderer disconnect must NOT call close() on this service. */
export class SessionHost {
  readonly spec: SessionSpec;
  readonly binding: BackendBinding;
  readonly plan: BindingPlan;
  readonly #manifestPath: string;
  readonly #activityIndexPath: string;
  readonly #title?: string;
  readonly #target: ExecutionTarget;
  readonly #catalog: ModelCatalogPort;
  readonly #adapter: HarnessAdapter;
  readonly #commands: CommandJournal;
  readonly #events: EventJournal;
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #active = new Set<Promise<void>>();
  readonly #interactions = new Map<string, string>();
  readonly #unsettledTurns = new Set<string>();
  readonly #preparedTurns = new Map<string, PreparedHostBinding>();
  #activeTurn?: string;
  #lastKnownStatus: AgentHostSessionSummary["lastKnownStatus"] = "idle";
  #recentOutcome: AgentHostSessionSummary["recentOutcome"] = "none";
  #lastActivityAt = 0;
  #eventTail: Promise<void> = Promise.resolve();
  #eventFailure?: Error;
  #signalEventStreamBroken!: () => void;
  /** Settles once the event stream breaks; turn-settlement waits race it instead of hanging. */
  readonly #eventStreamBroken = new Promise<void>((resolve) => {
    this.#signalEventStreamBroken = resolve;
  });
  #unsubscribe: () => void;
  #closed = false;

  // 事件流损坏后 dispatch() 拒绝一切命令，包括能结束打开 turn 的 cancel/resolve/terminate；
  // 写入错误的同时唤醒 whenIdle()，否则它会永远等一个再也结束不了的 adapter run。
  get #eventError(): Error | undefined {
    return this.#eventFailure;
  }
  set #eventError(error: Error | undefined) {
    this.#eventFailure = error;
    if (error) this.#signalEventStreamBroken();
  }

  private constructor(options: {
    manifestPath: string;
    activityIndexPath: string;
    spec: SessionSpec;
    title?: string;
    plan: BindingPlan;
    binding: BackendBinding;
    target: ExecutionTarget;
    catalog: ModelCatalogPort;
    adapter: HarnessAdapter;
    commands: CommandJournal;
    events: EventJournal;
  }) {
    this.#manifestPath = options.manifestPath;
    this.#activityIndexPath = options.activityIndexPath;
    this.spec = options.spec;
    this.#title = options.title;
    this.#target = options.target;
    this.#catalog = options.catalog;
    this.plan = options.plan;
    this.binding = options.binding;
    this.#adapter = options.adapter;
    this.#commands = options.commands;
    this.#events = options.events;
    for (const event of this.#events.since(0)) this.#applyEventState(event);
    this.#unsubscribe = options.adapter.subscribe(options.spec.hostSessionId, (source) => {
      // 旧 runtimeEpoch 后端的迟到事件不属于当前代际：journal 本来就不会收它，这里记录后丢弃，
      // 而不是让 appendWithStatus 抛错并把 #eventError 永久锁死当前会话。别的会话的事件仍失败关闭。
      if (
        source.hostSessionId === this.spec.hostSessionId &&
        source.runtimeEpoch !== this.binding.runtimeEpoch
      ) {
        logger.warn(undefined, "dropped late event from an older runtime epoch", {
          hostSessionId: source.hostSessionId,
          eventRuntimeEpoch: source.runtimeEpoch,
          currentRuntimeEpoch: this.binding.runtimeEpoch,
          kind: source.kind,
          sequence: source.sequence,
        });
        return;
      }
      this.#eventTail = this.#eventTail
        .then(async () => {
          if (this.#eventError) return;
          const { event, appended } = await this.#events.appendWithStatus(source);
          if (!appended) return;
          this.#applyEventState(event);
          await this.#persistActivityIndex();
          for (const listener of this.#listeners) listener(event);
        })
        .catch((error: unknown) => {
          this.#eventError = error instanceof Error ? error : new Error(String(error));
        });
    });
  }

  static async create(
    options: SessionHostOptions & {
      title?: string;
      creationRequest?: { requestId: string; requestFingerprint: string };
    },
  ): Promise<SessionHost> {
    const spec = sessionSpecSchema.parse(options.spec);
    // 原生 V4 是唯一可写 owner。在创建 manifest 之前拒绝，避免留下第二份会话状态。
    if (spec.harness.id === "zcode")
      throw new Error("native sessions must use the existing V4 route");
    // 删除中的工作区由 worktree 服务拒绝。这里只读它的结论，并且在写 manifest 之前停住。
    if (options.workspaces) {
      assertWorkspaceExecution(await options.workspaces.readExecution(spec.hostSessionId), {
        targetId: spec.execution.targetId,
        ...(spec.execution.workspaceId ? { workspaceId: spec.execution.workspaceId } : {}),
        worktreePath: spec.execution.worktreePath,
        ...(spec.execution.worktreeGeneration
          ? { worktreeGeneration: spec.execution.worktreeGeneration }
          : {}),
      });
    }
    const target = executionTargetSchema.parse(options.target);
    const adapter = options.registry.require(spec.harness.id);
    const catalog = captureModelCatalog(options.catalog);
    const plan = await planModelBinding({
      spec,
      target,
      harness: adapter,
      catalog,
    });
    if (plan.support.support !== "supported")
      throw (
        staleModelBindingError(spec, catalog) ??
        new Error(plan.support.reason ?? "unsupported model binding")
      );
    const prepared = await prepareHostBinding(spec, adapter, catalog, plan, options.catalog);
    assertCatalogCurrent(catalog);
    const path = manifestPath(options.root, spec);
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    // Mark an in-flight create before backend launch. Crash at this point is unknown, not retried.
    const handle = await open(path, "wx", 0o600);
    try {
      const initial = manifestSchema.parse({
        schemaVersion: 1,
        state: "creating",
        spec,
        ...(options.title ? { title: options.title } : {}),
        ...(options.creationRequest ? { creationRequest: options.creationRequest } : {}),
        plan,
      });
      await handle.writeFile(JSON.stringify(initial));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const binding = backendBindingSchema.parse(await adapter.create(spec, plan, prepared));
    if (binding.hostSessionId !== spec.hostSessionId || binding.backendVersion !== adapter.version)
      throw new Error("backend identity mismatch");
    await saveManifest(path, {
      schemaVersion: 1,
      state: "running",
      spec,
      ...(options.title ? { title: options.title } : {}),
      ...(options.creationRequest ? { creationRequest: options.creationRequest } : {}),
      plan,
      binding,
    });
    const host = await SessionHost.#mount(
      options.root,
      path,
      spec,
      plan,
      binding,
      target,
      options.catalog,
      adapter,
      options.title,
    );
    await host.#persistActivityIndex();
    return host;
  }

  static async open(options: SessionHostOptions): Promise<SessionHost> {
    const spec = sessionSpecSchema.parse(options.spec);
    // 打开路径同样不能把 zcode 挂成外部 owner，也不能为了检查而创建目录。
    if (spec.harness.id === "zcode")
      throw new Error("native sessions must use the existing V4 route");
    const path = manifestPath(options.root, spec);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (JSON.stringify(manifest.spec) !== JSON.stringify(spec))
      throw new Error("session identity or configuration mismatch");
    if (!manifest.binding || manifest.state === "creating")
      throw new Error("execution-unknown: backend create was not confirmed");
    if (manifest.state === "terminated")
      throw new Error("terminated session is history-only; never restart its backend");
    const adapter = options.registry.require(spec.harness.id);
    if (adapter.version !== manifest.binding.backendVersion)
      throw new Error("backend version mismatch: history only");
    const catalog = captureModelCatalog(options.catalog);
    const plan = await planModelBinding({
      spec,
      target: executionTargetSchema.parse(options.target),
      harness: adapter,
      catalog,
    });
    if (plan.support.support !== "supported")
      throw (
        staleModelBindingError(spec, catalog) ??
        new Error(plan.support.reason ?? "unsupported model binding")
      );
    const prepared = await prepareHostBinding(spec, adapter, catalog, plan, options.catalog);
    assertCatalogCurrent(catalog);
    const host = await SessionHost.#mount(
      options.root,
      path,
      spec,
      plan,
      manifest.binding,
      executionTargetSchema.parse(options.target),
      options.catalog,
      adapter,
      manifest.title,
    );
    try {
      await adapter.attach(spec, manifest.binding, host.snapshot().seq, plan, prepared);
      await host.whenEventsSettled();
      await host.#persistActivityIndex();
    } catch (error) {
      await host.close();
      throw error;
    }
    return host;
  }

  /** Read-only recovery path: does not load an adapter, call a Provider or start a worker. */
  static async snapshotHistory(
    root: string,
    spec: SessionSpec,
    options: { windowSize?: number; beforeRowId?: number } = {},
  ) {
    const { binding, identity } = await SessionHost.#storedHistory(root, spec);
    const journal = await EventJournal.open(root, identity);
    try {
      const events: AgentEvent[] = [];
      while (true) {
        const batch = journal.since(events.length);
        events.push(...batch);
        if (batch.length < 500) break;
      }
      return projectHostConversation({
        spec,
        runtimeEpoch: binding.runtimeEpoch,
        events,
        ...options,
      });
    } finally {
      await journal.close();
    }
  }

  static async eventsSinceHistory(
    root: string,
    spec: SessionSpec,
    sequence: number,
  ): Promise<readonly AgentEvent[]> {
    const { identity } = await SessionHost.#storedHistory(root, spec);
    const journal = await EventJournal.open(root, identity);
    try {
      return journal.since(sequence);
    } finally {
      await journal.close();
    }
  }

  static async queryCommandHistory(
    root: string,
    spec: SessionSpec,
    commandId: string,
  ): Promise<AgentCommandReceipt | undefined> {
    const { identity } = await SessionHost.#storedHistory(root, spec);
    const journal = await CommandJournal.open(root, identity);
    try {
      return journal.query(commandId);
    } finally {
      await journal.close();
    }
  }

  /** Target-local sidecar index; never inserts external sessions into native CLI storage. */
  static async listStoredSessions(
    root: string,
    input: {
      targetId: string;
      workspaceIdentity?: string;
      worktreePath?: string;
    },
  ): Promise<StoredAgentSessionSummary[]> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: StoredAgentSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".session.json")) continue;
      const path = join(root, entry.name);
      const metadata = await stat(path);
      if (metadata.size > 128 * 1024)
        throw new Error("oversized external session manifest; manual inspection required");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const parsed = manifestSchema.safeParse(value);
      if (!parsed.success)
        throw new Error("unreadable or future external session manifest; refusing to hide history");
      const manifest = parsed.data;
      if (manifest.spec.execution.targetId !== input.targetId) continue;
      if (
        input.workspaceIdentity !== undefined &&
        manifest.spec.execution.workspaceIdentity !== input.workspaceIdentity
      )
        continue;
      if (
        input.worktreePath !== undefined &&
        manifest.spec.execution.worktreePath !== input.worktreePath
      )
        continue;
      summaries.push({
        spec: manifest.spec,
        state: manifest.state,
        ...(manifest.title ? { title: manifest.title } : {}),
        updatedAt: metadata.mtimeMs,
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Finds a durable create receipt from manifests only; it never loads a worker or journal. */
  static async findStoredCreation(
    root: string,
    targetId: string,
    requestId: string,
  ): Promise<{
    spec: SessionSpec;
    title?: string;
    requestFingerprint: string;
    state: Manifest["state"];
  } | null> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".session.json")) continue;
      const path = join(root, entry.name);
      const metadata = await stat(path);
      if (metadata.size > 128 * 1024)
        throw new Error("oversized external session manifest; manual inspection required");
      const parsed = manifestSchema.safeParse(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (!parsed.success)
        throw new Error("unreadable or future external session manifest; refusing to hide history");
      const manifest = parsed.data;
      if (
        manifest.spec.execution.targetId === targetId &&
        manifest.creationRequest?.requestId === requestId
      ) {
        return {
          spec: manifest.spec,
          ...(manifest.title ? { title: manifest.title } : {}),
          requestFingerprint: manifest.creationRequest.requestFingerprint,
          state: manifest.state,
        };
      }
    }
    return null;
  }

  /** Reads bounded activity sidecars and manifests, never event or command transcripts. */
  static async listStoredActivityIndex(
    root: string,
    targetId: string,
  ): Promise<AgentHostActivityIndexEntry[]> {
    const records = await SessionHost.listStoredSessions(root, { targetId });
    return await Promise.all(
      records.map(async (record): Promise<AgentHostActivityIndexEntry> => {
        const unknown: AgentHostActivityIndexEntry = {
          spec: record.spec,
          runtimeEpoch: null,
          sequence: 0,
          state: "unknown",
          activeTurnId: null,
          pendingInteractionIds: [],
        };
        if (record.state === "creating") return unknown;
        try {
          const path = activityIndexPath(manifestPath(root, record.spec));
          const metadata = await stat(path);
          if (metadata.size > 16 * 1024) return unknown;
          const raw: unknown = JSON.parse(await readFile(path, "utf8"));
          const parsed = activityIndexEntrySchema.safeParse(raw);
          if (!parsed.success || JSON.stringify(parsed.data.spec) !== JSON.stringify(record.spec))
            return unknown;
          const stored = parsed.data;
          if (
            stored.state === "idle" &&
            (stored.activeTurnId !== null || stored.pendingInteractionIds.length > 0)
          )
            return unknown;
          // Unmounted busy is a historical fact, not proof the execution owner is alive.
          const state =
            stored.state === "busy" || (record.state === "terminated" && stored.state !== "idle")
              ? "unknown"
              : stored.state;
          return {
            spec: stored.spec,
            runtimeEpoch: stored.runtimeEpoch,
            sequence: stored.sequence,
            state,
            activeTurnId: stored.activeTurnId,
            pendingInteractionIds: stored.pendingInteractionIds,
          };
        } catch (error: unknown) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return unknown;
          throw error;
        }
      }),
    );
  }

  static async #storedHistory(
    root: string,
    raw: SessionSpec,
  ): Promise<{ binding: BackendBinding; identity: JournalIdentity }> {
    const spec = sessionSpecSchema.parse(raw);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(manifestPath(root, spec), "utf8")),
    );
    if (JSON.stringify(manifest.spec) !== JSON.stringify(spec))
      throw new Error("session identity or configuration mismatch");
    if (!manifest.binding) throw new Error("execution-unknown: backend create was not confirmed");
    return {
      binding: manifest.binding,
      identity: {
        targetId: spec.execution.targetId,
        workspaceIdentity: spec.execution.workspaceIdentity,
        harnessId: spec.harness.id,
        hostSessionId: spec.hostSessionId,
        runtimeEpoch: manifest.binding.runtimeEpoch,
      },
    };
  }

  static async #mount(
    root: string,
    path: string,
    spec: SessionSpec,
    plan: BindingPlan,
    binding: BackendBinding,
    target: ExecutionTarget,
    catalog: ModelCatalogPort,
    adapter: HarnessAdapter,
    title?: string,
  ): Promise<SessionHost> {
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
      return new SessionHost({
        manifestPath: path,
        activityIndexPath: activityIndexPath(path),
        spec,
        ...(title ? { title } : {}),
        plan,
        binding,
        target,
        catalog,
        adapter,
        commands,
        events,
      });
    } catch (error) {
      await events.close();
      throw error;
    }
  }

  async dispatch(raw: AgentCommand): Promise<AgentCommandReceipt> {
    if (this.#closed) throw new Error("session host closed");
    if (this.#eventError) throw this.#eventError;
    const command = agentCommandSchema.parse(raw);
    if (command.hostSessionId !== this.spec.hostSessionId)
      throw new Error("foreign session command");
    if (command.type === "send") {
      await this.#eventTail;
      if (this.#eventError) throw this.#eventError;
    }
    let sendReserved = false;
    let receipt: AgentCommandReceipt;
    try {
      receipt = await this.#commands.accept(
        command,
        command.type === "send"
          ? async () => {
              if (this.#commands.hasUncertainSend()) {
                return rejectedAdmission(
                  command,
                  "execution-unknown",
                  "previous prompt may have executed; inspect history before explicit recovery",
                );
              }
              if (this.#activeTurn || this.#unsettledTurns.size > 0) {
                return rejectedAdmission(command, "unsupported", "session busy");
              }
              let prepared: PreparedTurnContext | undefined;
              try {
                prepared = await this.#prepareTurn(command);
                await this.#adapter.prepareTurn?.(this.spec, prepared.binding);
                assertCatalogCurrent(prepared.catalog);
              } catch (error) {
                if (prepared)
                  await this.#adapter.discardPreparedTurn?.(this.spec, prepared.binding);
                return rejectedAdmission(
                  command,
                  error instanceof BindingPreparationFailure ? error.reasonCode : "invalid-binding",
                  error instanceof Error ? error.message : "model binding preparation failed",
                  error instanceof BindingPreparationFailure ? error.failure : undefined,
                );
              }
              this.#preparedTurns.set(command.commandId, prepared.binding);
              // 修复依据：模型/route/credential 预检在现有 admission lane 内完成；只有可执行
              // 的冻结 binding 才能先落 busy、再 accepted，避免无副作用失败变成 uncertain。
              this.#activeTurn = command.turnId;
              this.#unsettledTurns.add(command.turnId);
              this.#lastKnownStatus = "starting";
              try {
                await this.#persistActivityIndex();
              } catch (error) {
                this.#preparedTurns.delete(command.commandId);
                await this.#adapter.discardPreparedTurn?.(this.spec, prepared.binding);
                await this.#releaseSendReservation(command);
                return rejectedAdmission(
                  command,
                  "backend-failure",
                  error instanceof Error ? error.message : "could not persist send admission",
                );
              }
              sendReserved = true;
              return {
                kind: "accepted" as const,
                bindingFact: createTurnBindingAuditFact(command.turnId, prepared.binding.plan),
              };
            }
          : undefined,
      );
    } catch (error) {
      if (command.type === "send" && sendReserved) {
        const prepared = this.#preparedTurns.get(command.commandId);
        this.#preparedTurns.delete(command.commandId);
        if (prepared) await this.#adapter.discardPreparedTurn?.(this.spec, prepared);
        await this.#releaseSendReservation(command);
      }
      throw error;
    }
    if (receipt.status === "duplicate") return receipt;
    if (receipt.status !== "accepted") return receipt;
    await this.#eventTail;
    if (this.#closed) {
      if (sendReserved) {
        const prepared = this.#preparedTurns.get(command.commandId);
        this.#preparedTurns.delete(command.commandId);
        if (prepared) await this.#adapter.discardPreparedTurn?.(this.spec, prepared);
        await this.#releaseSendReservation(command as Extract<AgentCommand, { type: "send" }>);
      }
      return this.#reject(command, "backend-failure", "session host is closing");
    }
    if (this.#eventError) {
      if (command.type === "send") {
        const prepared = this.#preparedTurns.get(command.commandId);
        this.#preparedTurns.delete(command.commandId);
        if (prepared) await this.#adapter.discardPreparedTurn?.(this.spec, prepared);
        await this.#releaseSendReservation(command);
      }
      return this.#reject(command, "backend-failure", "event stream is no longer reliable");
    }
    if (command.type === "send") {
      const prepared = this.#preparedTurns.get(command.commandId);
      this.#preparedTurns.delete(command.commandId);
      if (!prepared)
        return this.#reject(command, "backend-failure", "accepted send lost its prepared binding");
      try {
        const run = this.#adapter.send(command, prepared);
        this.#track(command.commandId, command.turnId, run);
        return receipt;
      } catch (error) {
        // 同步异常不证明 Harness 尚未产生副作用；保留 execution-unknown，禁止盲目重发。
        const uncertain: AgentCommandReceipt = {
          commandId: command.commandId,
          status: "execution-unknown",
          reasonCode: "execution-unknown",
          message: error instanceof Error ? error.message : "backend failed",
        };
        this.#lastKnownStatus = "unknown";
        await this.#commands.finish(command.commandId, uncertain);
        await this.#persistActivityIndex();
        return uncertain;
      }
    }
    try {
      switch (command.type) {
        case "cancelTurn":
          if (!this.#isCurrentTurn(command))
            return this.#reject(command, "stale-turn", "turn or epoch changed");
          await this.#adapter.cancelTurn(command);
          break;
        case "resolveInteraction":
          if (
            !this.#isCurrentTurn(command) ||
            this.#interactions.get(command.interactionId) !== command.turnId
          ) {
            return this.#reject(command, "stale-interaction", "interaction or epoch changed");
          }
          await this.#adapter.resolveInteraction(command);
          break;
        case "detach": // Closing a UI subscription never touches the target worker.
        case "viewHistory":
          break;
        case "terminateSession": {
          await this.#adapter.terminate(this.spec.hostSessionId);
          const existingManifest = manifestSchema.parse(
            JSON.parse(await readFile(this.#manifestPath, "utf8")) as unknown,
          );
          await saveManifest(this.#manifestPath, { ...existingManifest, state: "terminated" });
          break;
        }
        case "resumeExecution":
          return this.#reject(command, "unsupported", "backend native resume is not implemented");
        case "createSession":
          return this.#reject(command, "duplicate-id", "session already created");
      }
      const done: AgentCommandReceipt = { commandId: command.commandId, status: "completed" };
      await this.#commands.finish(command.commandId, done);
      return done;
    } catch (error) {
      return this.#reject(
        command,
        "backend-failure",
        error instanceof Error ? error.message : "backend failed",
      );
    }
  }

  async #prepareTurn(
    command: Extract<AgentCommand, { type: "send" }>,
  ): Promise<PreparedTurnContext> {
    const catalog = captureModelCatalog(this.#catalog);
    const plan = await planModelBinding({
      spec: this.spec,
      target: this.#target,
      harness: this.#adapter,
      catalog,
    });
    if (plan.support.support !== "supported") {
      // 会话自身绑定的 Provider/模型已不在目录中（被删除等）：需要用户重新配置，
      // 不能与 busy / 未认证 harness 共用 unsupported，也绝不换成其他模型。
      const selection =
        this.spec.modelBinding.kind === "host-managed"
          ? this.spec.modelBinding.selection
          : undefined;
      throw new BindingPreparationFailure(
        selection && !catalog.validateSelection(selection).ok ? "invalid-binding" : "unsupported",
        plan.support.reason ?? "model binding is not supported for this turn",
      );
    }
    // Provider credential rejected earlier (401) and not reconfigured since: refuse here,
    // before any Model is bound or called; other Providers are unaffected.
    const attention =
      plan.requested.kind === "host-managed" && plan.effective
        ? catalog.credentialAttention?.(plan.effective)
        : undefined;
    if (attention)
      throw new BindingPreparationFailure(
        "provider-reconfigure-required",
        attention.message,
        attention.failure,
      );
    const binding = {
      ...(await prepareHostBinding(this.spec, this.#adapter, catalog, plan, this.#catalog)),
      turnId: command.turnId,
    };
    assertCatalogCurrent(catalog);
    return { binding, catalog };
  }

  eventsSince(sequence: number): readonly AgentEvent[] {
    return this.#events.since(sequence);
  }
  snapshot(options: { windowSize?: number; beforeRowId?: number } = {}) {
    const events: AgentEvent[] = [];
    while (true) {
      const batch = this.#events.since(events.length);
      events.push(...batch);
      if (batch.length < 500) break;
    }
    return projectHostConversation({
      spec: this.spec,
      runtimeEpoch: this.binding.runtimeEpoch,
      events,
      ...options,
    });
  }
  queryCommand(commandId: string): AgentCommandReceipt | undefined {
    return this.#commands.query(commandId);
  }
  queryBindingFact(commandId: string): TurnBindingAuditFact | undefined {
    return this.#commands.queryBindingFact(commandId);
  }
  summary(): AgentHostSessionSummary {
    return agentHostSessionSummarySchema.parse({
      spec: this.spec,
      title: this.#title ?? this.spec.hostSessionId,
      lastKnownStatus: this.#lastKnownStatus,
      freshness: "live",
      recentOutcome: this.#recentOutcome,
      pendingInteractionCount: this.#interactions.size,
      unread: false,
      updatedAt: this.#lastActivityAt,
      archived: false,
      kind: "top-level",
    });
  }
  activityIndexEntry(): AgentHostActivityIndexEntry {
    const pendingInteractionIds = [...this.#interactions.keys()];
    const unknown =
      this.#eventError !== undefined ||
      this.#commands.hasUncertainSend() ||
      this.#lastKnownStatus === "failed" ||
      this.#lastKnownStatus === "unknown";
    const busy =
      this.#activeTurn !== undefined ||
      this.#unsettledTurns.size > 0 ||
      pendingInteractionIds.length > 0 ||
      this.#lastKnownStatus === "starting" ||
      this.#lastKnownStatus === "running" ||
      this.#lastKnownStatus === "waiting" ||
      this.#lastKnownStatus === "cancelling";
    return {
      spec: this.spec,
      runtimeEpoch: this.binding.runtimeEpoch,
      sequence: this.#events.sequence,
      state: unknown ? "unknown" : busy ? "busy" : "idle",
      activeTurnId: this.#activeTurn ?? null,
      pendingInteractionIds,
    };
  }
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async whenEventsSettled(): Promise<void> {
    await this.#eventTail;
    if (this.#eventError) throw this.#eventError;
  }
  async whenIdle(): Promise<void> {
    // A broken stream can no longer settle an open turn (see #eventError): stop waiting and
    // report the stream error instead of awaiting an adapter run that nothing can end.
    await Promise.race([Promise.all(this.#active), this.#eventStreamBroken]);
    await this.whenEventsSettled();
  }
  /**
   * Healthy stream: refuses while a turn is active; the caller can still cancel or terminate it.
   * Broken stream: no command can end the turn any more, so force-close (unsubscribe, close the
   * journals; an in-flight send stays durable accepted = execution-unknown, never replayed) and
   * reject with EventStreamFailure so the caller knows the session ended unhealthy.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#active.size && !this.#eventError)
      throw new Error(
        "active turn: detach a client, cancel the turn or terminate the session before closing the host",
      );
    try {
      await this.whenIdle();
    } catch (error) {
      if (!this.#eventError) throw error;
    }
    const failure = this.#eventError;
    this.#closed = true;
    this.#unsubscribe();
    if (failure) await this.#persistForceClosedActivity(failure);
    await this.#commands.close();
    await this.#events.close();
    if (failure) throw new EventStreamFailure(failure);
  }

  /**
   * The last sidecar write predates the stream break, so an unmounted session with no open turn
   * would keep listing "idle". activityIndexEntry() already derives "unknown" from #eventError;
   * persist that. Best-effort: a failed write is logged and never masks EventStreamFailure.
   */
  async #persistForceClosedActivity(failure: Error): Promise<void> {
    try {
      await this.#persistActivityIndex();
    } catch (error) {
      logger.warn(undefined, "force-closed session activity sidecar not rewritten", {
        hostSessionId: this.spec.hostSessionId,
        eventStreamError: failure.message,
        error,
      });
    }
  }

  async #persistActivityIndex(): Promise<void> {
    const entry = activityIndexEntrySchema.parse({
      schemaVersion: 1,
      ...this.activityIndexEntry(),
    });
    const tempPath = `${this.#activityIndexPath}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(tempPath, "wx", 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(entry));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tempPath, this.#activityIndexPath);
    } catch (error) {
      // The temp file is ours ("wx" + uuid); never leave it next to the sidecar. Cleanup is
      // best-effort so callers keep seeing the write/rename error, not the unlink one.
      await unlink(tempPath).catch((cleanup: unknown) => {
        if ((cleanup as NodeJS.ErrnoException).code === "ENOENT") return;
        logger.warn(undefined, "activity sidecar temp file not removed", {
          hostSessionId: this.spec.hostSessionId,
          error: cleanup,
        });
      });
      throw error;
    }
  }

  #track(commandId: string, turnId: string, run: Promise<void>): void {
    const tracked = run.then(
      async () => {
        await this.#eventTail;
        // Force-closed with a broken stream: the journals are closed and the send stays uncertain.
        if (this.#closed) return;
        if (this.#eventError || this.#activeTurn === turnId) {
          this.#lastKnownStatus = "unknown";
          await this.#commands.finish(commandId, {
            commandId,
            status: "execution-unknown",
            reasonCode: "execution-unknown",
          });
        } else {
          await this.#commands.finish(commandId, { commandId, status: "completed" });
          this.#unsettledTurns.delete(turnId);
        }
        await this.#persistActivityIndex();
      },
      async () => {
        await this.#eventTail;
        if (this.#closed) return;
        this.#lastKnownStatus = "unknown";
        await this.#commands.finish(commandId, {
          commandId,
          status: "execution-unknown",
          reasonCode: "execution-unknown",
        });
        await this.#persistActivityIndex();
      },
    );
    this.#active.add(tracked);
    void tracked.then(
      () => this.#active.delete(tracked),
      () => this.#active.delete(tracked),
    );
  }
  #isCurrentTurn(command: { runtimeEpoch: string; turnId: string }): boolean {
    return (
      command.runtimeEpoch === this.binding.runtimeEpoch && command.turnId === this.#activeTurn
    );
  }
  #applyEventState(event: AgentEvent): void {
    this.#lastActivityAt = event.at;
    if (event.kind === "turn.started") {
      this.#activeTurn = event.turnId;
      this.#lastKnownStatus = "running";
    }
    if (event.kind === "interaction.requested") {
      this.#interactions.set(event.interactionId, event.turnId);
      this.#activeTurn ??= event.turnId;
      this.#lastKnownStatus = "waiting";
    }
    if (event.kind === "interaction.resolved") {
      this.#interactions.delete(event.interactionId);
      // 审批答复可能刚放行工具；它本身不表示当前 turn 已结束。
      this.#lastKnownStatus = this.#activeTurn ? "running" : "unknown";
    }
    if (event.kind === "turn.finished") {
      if (event.turnId !== this.#activeTurn) throw new Error("out-of-order turn completion");
      this.#activeTurn = undefined;
      this.#interactions.clear();
      this.#lastKnownStatus = "completed";
      this.#recentOutcome =
        event.outcome === "success"
          ? "success"
          : event.outcome === "cancelled"
            ? "cancelled"
            : event.outcome === "failed"
              ? "failed"
              : "unknown";
    }
    if (event.kind === "session.error") {
      this.#lastKnownStatus = "failed";
      this.#recentOutcome = "failed";
    }
    if (event.kind === "session.status") {
      if (event.state === "idle") {
        this.#activeTurn = undefined;
        this.#interactions.clear();
        this.#lastKnownStatus = "idle";
      } else if (event.state === "running") {
        this.#lastKnownStatus = "running";
      } else {
        this.#lastKnownStatus = "unknown";
      }
    }
  }

  async #releaseSendReservation(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    this.#unsettledTurns.delete(command.turnId);
    if (this.#activeTurn === command.turnId) this.#activeTurn = undefined;
    if (this.#lastKnownStatus === "starting") this.#lastKnownStatus = "idle";
    await this.#persistActivityIndex();
  }
  async #reject(
    command: AgentCommand,
    reasonCode: NonNullable<AgentCommandReceipt["reasonCode"]>,
    message: string,
  ): Promise<AgentCommandReceipt> {
    const receipt: AgentCommandReceipt = {
      commandId: command.commandId,
      status: "rejected",
      reasonCode,
      message,
    };
    await this.#commands.finish(command.commandId, receipt);
    return receipt;
  }
}

/**
 * close() of a host whose event stream broke: resources are released, the session ended unhealthy.
 * `code` matches the receipt reasonCode dispatch() uses for the same condition; `cause` is the
 * original stream error.
 */
export class EventStreamFailure extends Error {
  readonly code = "backend-failure" as const;
  constructor(cause: Error) {
    // Same wording as dispatch()'s rejection; the cause text stays matchable for existing callers.
    super(`event stream is no longer reliable: ${cause.message}`, { cause });
    this.name = "EventStreamFailure";
  }
}

class BindingPreparationFailure extends Error {
  constructor(
    readonly reasonCode: NonNullable<AgentCommandReceipt["reasonCode"]>,
    message: string,
    readonly failure?: AgentCommandReceipt["failure"],
  ) {
    super(message);
  }
}

function captureModelCatalog(catalog: ModelCatalogPort): ModelCatalogSnapshotPort {
  return catalog.capture?.() ?? catalog;
}

async function prepareHostBinding(
  spec: SessionSpec,
  adapter: HarnessAdapter,
  catalog: ModelCatalogSnapshotPort,
  plan: BindingPlan,
  currentCatalog: ModelCatalogPort,
): Promise<PreparedHostBinding> {
  let model: Model | undefined;
  if (plan.requested.kind === "host-managed" && plan.route !== "mock") {
    model = catalog.bindModel
      ? await catalog.bindModel(plan)
      : await adapter.prepareModel?.(spec, plan);
    if (!model)
      throw new BindingPreparationFailure(
        "invalid-binding",
        "host-managed route has no Model binding port",
      );
    if (
      !plan.effective ||
      model.providerId !== plan.effective.providerId ||
      model.modelId !== plan.effective.modelId
    ) {
      throw new BindingPreparationFailure(
        "invalid-binding",
        "Model executor returned a different Provider/model route",
      );
    }
    model = guardModelForCurrentSelection(model, plan.effective, currentCatalog);
  }
  return { plan, ...(model ? { model } : {}) };
}

function guardModelForCurrentSelection(
  model: Model,
  selection: NonNullable<BindingPlan["effective"]>,
  catalog: ModelCatalogPort,
): Model {
  const guard = (bound: Model): Model => ({
    providerId: bound.providerId,
    modelId: bound.modelId,
    ...(bound.displayName ? { displayName: bound.displayName } : {}),
    properties: bound.properties,
    optionSpecs: bound.optionSpecs,
    options: bound.options,
    bind: (options) => guard(bound.bind(options)),
    generateText: (request) => {
      assertSelectionStillAvailable(selection, catalog);
      return bound.generateText(request);
    },
    streamText: (request) => {
      assertSelectionStillAvailable(selection, catalog);
      return bound.streamText(request);
    },
  });
  return guard(model);
}

function assertSelectionStillAvailable(
  selection: NonNullable<BindingPlan["effective"]>,
  catalog: ModelCatalogPort,
): void {
  const validation = catalog.validateSelection(selection);
  if (!validation.ok)
    throw new Error(`Active turn model selection was revoked: ${validation.reason}`);
}

function assertCatalogCurrent(catalog: ModelCatalogSnapshotPort): void {
  if (catalog.isCurrent && !catalog.isCurrent()) {
    throw new BindingPreparationFailure(
      "invalid-binding",
      "Model catalog changed during turn binding preparation; retry the send",
    );
  }
}

function createTurnBindingAuditFact(turnId: string, plan: BindingPlan): TurnBindingAuditFact {
  return {
    schemaVersion: 1,
    turnId,
    targetId: plan.targetId,
    harnessId: plan.harnessId,
    adapterVersion: plan.adapterVersion,
    catalogFingerprint: plan.catalogFingerprint,
    requested: plan.requested,
    ...(plan.effective ? { effective: plan.effective } : {}),
    ...(plan.route ? { route: plan.route } : {}),
    ...(plan.credentialSource ? { credentialSource: plan.credentialSource } : {}),
  };
}

function rejectedAdmission(
  command: AgentCommand,
  reasonCode: NonNullable<AgentCommandReceipt["reasonCode"]>,
  message: string,
  failure?: AgentCommandReceipt["failure"],
): CommandAdmissionDecision {
  return {
    kind: "rejected",
    receipt: {
      commandId: command.commandId,
      status: "rejected",
      reasonCode,
      message,
      ...(failure ? { failure } : {}),
    },
  };
}

function manifestPath(root: string, spec: SessionSpec): string {
  const identity = [
    spec.execution.targetId,
    spec.execution.workspaceIdentity,
    spec.harness.id,
    spec.hostSessionId,
  ];
  return join(
    root,
    `${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.session.json`,
  );
}

function activityIndexPath(sessionManifestPath: string): string {
  return sessionManifestPath.replace(/\.session\.json$/, ".activity.json");
}

async function saveManifest(path: string, value: Manifest): Promise<void> {
  const checked = manifestSchema.parse(value);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(checked), { mode: 0o600 });
  await rename(tmp, path);
}
