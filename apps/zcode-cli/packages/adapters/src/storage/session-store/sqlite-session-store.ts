import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";
import { DatabaseSync } from "node:sqlite";
import type {
  CollaborationMode,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  CreateScriptWorkflowActivityInput,
  CreateScriptWorkflowRunInput,
  CreateSessionTaskLinkInput,
  CreateSessionInput,
  NativeCreateReceipt,
  NativeCreateReceiptCommit,
  FileDiff,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  GoalStatus,
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  ListSessionsInput,
  AppUsageQueryInput,
  AppUsageQueryResult,
  LocalSettingStorePort,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  ModelUsageRecord,
  PartId,
  PermissionRuleset,
  ProjectId,
  SessionEntryInfo,
  SessionEntryType,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  ScriptWorkflowStorePort,
  SessionGoal,
  SessionId,
  SessionInfo,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionTaskLinkRecord,
  SessionRevert,
  SessionStorePort,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  TodoItem,
  ToolUsageRecord,
  TurnUsageRecord,
  UpsertScriptWorkflowDefinitionInput,
  UpdateScriptWorkflowActivityInput,
  UpdateSessionInput,
  UpdateScriptWorkflowRunInput,
  UsageStorePort,
} from "@zcode/contracts";
// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import {
  accountSessionTargetUsage,
  clearSessionTarget,
  cloneSessionTargetForFork,
  createSessionTarget,
  finishSessionTargetRun,
  heartbeatSessionTargetRun,
  readSessionTarget,
  recoverInterruptedSessionTargetRun,
  setSessionTarget,
  startSessionTargetRun,
  updateSessionTargetSummaryTitle,
  updateSessionTargetStatus,
} from "../session-target.js";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
  type AsyncSqliteMigrationOptions,
} from "./migration-runner.js";
import type {
  ForkCommitFaultStage,
  SessionStoreDebugCounts,
  SqliteSessionStoreOptions,
} from "./options.js";
import { ensureParentDir, getDefaultSessionDbPath } from "./paths.js";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import * as debugRepository from "./repositories/debug.js";
import { createDwfJournalStore } from "./repositories/dwf-journal.js";
import * as inputHistoryRepository from "./repositories/input-history.js";
import * as localSettingsRepository from "./repositories/local-settings.js";
import * as messageRepository from "./repositories/messages.js";
import * as scriptWorkflowActivityRepository from "./repositories/script-workflow-activities.js";
import * as scriptWorkflowRunRepository from "./repositories/script-workflow-runs.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";
import * as todoRepository from "./repositories/todos.js";
import * as usageRepository from "./repositories/usage.js";

function forkChildSessionId(entry: SessionEntryInfo): SessionId | null {
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  const ack = (entry.data as Record<string, unknown>).ack;
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return null;
  const result = (ack as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const sessionId = (result as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? (sessionId as SessionId) : null;
}

function assertForkBundleChildLocal(bundle: ForkCommitBundle): void {
  const childId = String(bundle.child.id);
  const commandResult = bundle.commandFact.ack.result as unknown;
  const result =
    commandResult && typeof commandResult === "object" && !Array.isArray(commandResult)
      ? (commandResult as Record<string, unknown>)
      : null;
  const sessionId = typeof result?.sessionId === "string" ? result.sessionId.trim() : "";
  const isForkResult =
    result?.type === "forkAssistant" ||
    result?.type === "createSelectionSideSession" ||
    (result?.type === "editUserQuery" && result.disposition === "fork");
  if (!isForkResult || !sessionId || sessionId !== childId) {
    // 缺失或非 fork 的 command result 会留下无法重放到 child 的幂等事实。
    throw new Error("Fork bundle command result is missing, invalid, or not child-local");
  }
  const messageIds = new Set(bundle.messages.map((message) => String(message.info.id)));
  const assertMessage = (value: unknown, field: string) => {
    if (typeof value === "string" && !messageIds.has(value)) {
      throw new Error(`Fork bundle ${field} is not child-local: ${value}`);
    }
  };
  const targetIds = new Set<string>();
  if (bundle.goal) targetIds.add(bundle.goal.source.targetID);
  for (const message of bundle.messages) {
    if (String(message.info.sessionID) !== childId) {
      throw new Error("Fork bundle message session is not child-local");
    }
    if (message.info.role === "assistant" && !messageIds.has(String(message.info.parentID))) {
      throw new Error("Fork bundle assistant parent is not child-local");
    }
    const anchor = message.info.anchor;
    for (const id of anchor?.orderedMessageIds ?? []) {
      assertMessage(id, "anchor orderedMessageId");
    }
    assertMessage(anchor?.boundaryMessageId, "anchor boundaryMessageId");
    if (anchor?.goalBoundary?.kind === "snapshot") {
      if (String(anchor.goalBoundary.target.sessionID) !== childId) {
        throw new Error("Fork bundle anchor goal session is not child-local");
      }
      targetIds.add(anchor.goalBoundary.target.targetID);
    }
    for (const part of message.parts) {
      if (
        String(part.sessionID) !== childId ||
        String(part.messageID) !== String(message.info.id)
      ) {
        throw new Error("Fork bundle part owner is not child-local");
      }
      if (part.type === "timeline") {
        assertMessage(part.anchorMessageId, "timeline anchorMessageId");
        if (part.timelineType === "context_compaction") {
          assertMessage(part.summaryMessageId, "timeline summaryMessageId");
        }
        if (part.timelineType === "goal_verification") targetIds.add(part.targetId);
      }
      if (part.type === "compaction") {
        assertMessage(part.tail_start_id, "compaction tail_start_id");
        assertMessage(part.summaryMessageId, "compaction summaryMessageId");
        const boundary = part.compactBoundary;
        assertMessage(boundary?.lastSummarizedMessageId, "compact lastSummarizedMessageId");
        for (const id of boundary?.summaryMessageIds ?? []) {
          assertMessage(id, "compact summaryMessageId");
        }
        for (const id of boundary?.attachmentMessageIds ?? []) {
          assertMessage(id, "compact attachmentMessageId");
        }
        for (const id of boundary?.hookResultMessageIds ?? []) {
          assertMessage(id, "compact hookResultMessageId");
        }
        assertMessage(boundary?.preservedSegment?.headMessageId, "compact preserved head");
        assertMessage(boundary?.preservedSegment?.anchorMessageId, "compact preserved anchor");
        assertMessage(boundary?.preservedSegment?.tailMessageId, "compact preserved tail");
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) {
          if (
            String(attachment.sessionID) !== childId ||
            String(attachment.messageID) !== String(message.info.id)
          ) {
            throw new Error("Fork bundle tool attachment owner is not child-local");
          }
        }
      }
    }
  }
  if (bundle.goal && String(bundle.goal.source.sessionID) !== childId) {
    throw new Error("Fork bundle goal session is not child-local");
  }
  for (const entry of bundle.entries) {
    if (String(entry.sessionID) !== childId) {
      throw new Error("Fork bundle verifier entry session is not child-local");
    }
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : {};
    const payload =
      data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : {};
    assertMessage(payload.anchorAssistantMessageId, "verifier assistant anchor");
    if (typeof payload.targetId === "string" && !targetIds.has(payload.targetId)) {
      throw new Error("Fork bundle verifier target is not child-local");
    }
  }
}

const deferredStartup = Symbol("deferredSqliteStartup");

export class SqliteSessionStore
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly forkCommitFaultAt?: ForkCommitFaultStage;
  private readonly nativeCreateFaultAt?:
    | "beforeTransaction"
    | "afterSession"
    | "afterReceipt"
    | "afterCommit";
  private dwfJournalStore?: JournalStorePort;

  constructor(options: SqliteSessionStoreOptions = {}, startupToken?: symbol) {
    this.dbPath = options.dbPath ?? getDefaultSessionDbPath();
    this.forkCommitFaultAt = options.forkCommitFaultAt;
    this.nativeCreateFaultAt = options.nativeCreateFaultAt;
    const startupLockTimeoutMs =
      options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS;
    try {
      ensureParentDir(this.dbPath);
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: this.dbPath });
      // 多个本地或远程 Agent 会共享同一个 session DB；timeout 必须在执行首条
      // PRAGMA 前生效，否则并发启动会在 migration prelude 直接抛 database is locked。
      this.db = new DatabaseSync(this.dbPath, { timeout: startupLockTimeoutMs });
    } catch (error) {
      throw new SqliteSessionMigrationError(
        `Failed to open SQLite session database at ${this.dbPath}`,
        {
          cause: error,
          dbPath: this.dbPath,
          kind: "open_failed",
        },
      );
    }
    try {
      if (startupToken !== deferredStartup)
        runSqliteSessionMigrations(this.db, this.dbPath, startupLockTimeoutMs);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        /* 保留原始迁移失败。 */
      }
      throw error;
    }
  }

  static async openStartup(
    options: SqliteSessionStoreOptions = {},
    migrationOptions: AsyncSqliteMigrationOptions = {},
  ): Promise<SqliteSessionStore> {
    // 未迁移的实例只保留在这个工厂内部；所有 Repo/业务只可能拿到 COMMIT 后的连接。
    const store = new SqliteSessionStore(options, deferredStartup);
    try {
      await runSqliteSessionMigrationsAsync(store.db, store.dbPath, migrationOptions);
      return store;
    } catch (error) {
      // close 也可能因 IO 失败；迁移的原始 cause 才是用户应处理的原因。
      try {
        store.close();
      } catch {
        /* 保留原始迁移失败。 */
      }
      throw error;
    }
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  private throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }

  private maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void {
    if (this.forkCommitFaultAt === stage) {
      throw new Error(`injected fork commit fault: ${stage}`);
    }
  }

  async getNativeCreateReceipt(commandId: string): Promise<NativeCreateReceipt | null> {
    const row = this.db
      .prepare(`select command_id, session_id, workspace_scope, intent_fingerprint,
      has_first_input, status from native_create_receipt where command_id = ?`)
      .get(commandId) as
      | {
          command_id: string;
          session_id: string;
          workspace_scope: string;
          intent_fingerprint: string;
          has_first_input: number;
          status: string;
        }
      | undefined;
    if (!row) return null;
    // 账本事实必须有对应 native session，孤儿/部分数据不得变成可写 mapping。
    const session = sessionRepository.getSession(
      this.db,
      row.session_id as NativeCreateReceipt["originalSessionId"],
    );
    if (
      !session ||
      (session.workspaceID ?? session.directory) !== row.workspace_scope ||
      !row.command_id ||
      !row.workspace_scope ||
      !/^[a-f0-9]{64}$/.test(row.intent_fingerprint) ||
      ![0, 1].includes(row.has_first_input) ||
      !["pending", "completed"].includes(row.status)
    )
      return null;
    return {
      commandId: row.command_id,
      originalSessionId: row.session_id as NativeCreateReceipt["originalSessionId"],
      workspaceScope: row.workspace_scope,
      intentFingerprint: row.intent_fingerprint,
      hasFirstInput: row.has_first_input === 1,
      status: row.status === "completed" ? "completed" : "pending",
    };
  }

  async commitNativeCreateReceipt(input: NativeCreateReceiptCommit): Promise<NativeCreateReceipt> {
    if (
      !input.commandId ||
      !input.workspaceScope ||
      !/^[a-f0-9]{64}$/.test(input.intentFingerprint)
    ) {
      throw new Error("proto.invalidCreateReceipt");
    }
    this.throwBeforeWrite();
    if (this.nativeCreateFaultAt === "beforeTransaction")
      throw new Error("injected native create fault beforeTransaction");
    this.db.exec("begin immediate");
    let committed = false;
    try {
      const prior = await this.getNativeCreateReceipt(input.commandId);
      if (prior) {
        if (
          prior.workspaceScope !== input.workspaceScope ||
          prior.intentFingerprint !== input.intentFingerprint ||
          prior.hasFirstInput !== !!input.hasFirstInput
        ) {
          throw new Error("guard.nativeCreateIntentConflict");
        }
        this.db.exec("commit");
        return prior;
      }
      if (sessionRepository.getSession(this.db, input.session.id))
        throw new Error("guard.nativeCreateSessionCollision");
      sessionRepository.createSession(this.db, input.session);
      if (this.nativeCreateFaultAt === "afterSession")
        throw new Error("injected native create fault afterSession");
      this.db
        .prepare(`insert into native_create_receipt
        (command_id, session_id, workspace_scope, intent_fingerprint, has_first_input, status)
        values (?, ?, ?, ?, ?, 'pending')`)
        .run(
          input.commandId,
          input.session.id,
          input.workspaceScope,
          input.intentFingerprint,
          input.hasFirstInput ? 1 : 0,
        );
      if (this.nativeCreateFaultAt === "afterReceipt")
        throw new Error("injected native create fault afterReceipt");
      const receipt: NativeCreateReceipt = {
        commandId: input.commandId,
        originalSessionId: input.session.id,
        workspaceScope: input.workspaceScope,
        intentFingerprint: input.intentFingerprint,
        hasFirstInput: !!input.hasFirstInput,
        status: "pending",
      };
      this.db.exec("commit");
      committed = true;
      if (this.nativeCreateFaultAt === "afterCommit")
        throw new Error("injected native create fault afterCommit");
      return receipt;
    } catch (error) {
      if (!committed) this.db.exec("rollback");
      throw error;
    }
  }

  async completeNativeCreateReceipt(
    commandId: string,
    originalSessionId: SessionId,
    actual?: {
      modelSelection?: import("@zcode/shared").ModelSelection;
      mode: CollaborationMode;
      planEnabled: boolean;
    },
  ): Promise<void> {
    this.throwBeforeWrite();
    // 中文：原先先完成 receipt，匹配缺省模型的空草稿无 selection entry；重启后
    // 又取新的 workspace 缺省。实际配置与完成事实必须由同一 CLI SQLite owner 提交。
    this.db.exec("begin immediate");
    try {
      const receipt = await this.getNativeCreateReceipt(commandId);
      if (!receipt || receipt.originalSessionId !== originalSessionId)
        throw new Error("fault.command.nativeCreateReceiptMissing");
      if (actual) {
        const timestamp = Date.now();
        // 中文：后续显式切模会覆盖 runtime-model-selection；创建认证只能读取
        // 与原 command ID 绑定的不可变配置快照，不能从日后的当前值反推创建结果。
        const immutableId = `native-create-config:${commandId}`;
        if (this.db.prepare("select id from session_entry where id = ?").get(immutableId))
          throw new Error("guard.nativeCreateConfigAlreadyCommitted");
        sessionEntryRepository.saveSessionEntry(this.db, {
          id: immutableId,
          sessionID: originalSessionId,
          type: "native/create_config",
          touchSession: false,
          time: { created: timestamp, updated: timestamp },
          data: {
            selection: actual.modelSelection ?? null,
            execution: { mode: actual.mode, planEnabled: actual.planEnabled },
          },
        });
        if (actual.modelSelection)
          sessionEntryRepository.saveSessionEntry(this.db, {
            id: `${originalSessionId}:runtime-model-selection`,
            sessionID: originalSessionId,
            type: "runtime/model_selection",
            touchSession: false,
            time: { created: timestamp, updated: timestamp },
            data: actual.modelSelection,
          });
        sessionEntryRepository.saveSessionEntry(this.db, {
          id: `${originalSessionId}:runtime-execution-state`,
          sessionID: originalSessionId,
          type: "runtime/execution_state",
          touchSession: false,
          time: { created: timestamp, updated: timestamp },
          data: { mode: actual.mode, planEnabled: actual.planEnabled },
        });
      }
      const changed = this.db
        .prepare(`update native_create_receipt set status = 'completed'
        where command_id = ? and session_id = ?`)
        .run(commandId, originalSessionId).changes;
      if (changed !== 1) throw new Error("fault.command.nativeCreateReceiptMissing");
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.createSession(this.db, input);
  }

  async createForkedSessionWithMetadata(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    if (!input.parentID || String(input.parentID) !== metadata.parentSessionId) {
      throw new Error("Fork child metadata parent does not match session parentID");
    }
    const orderedMessageIds = metadata.forkTarget.orderedMessageIds;
    // compact 覆盖首轮 query 时，input 前稳定前缀合法为空；boundaryMessageId 仍记录
    // 被编辑 input，供幂等事实定位，但不会被复制进 child。
    const validBoundary =
      metadata.forkTarget.boundaryMessageId.trim().length > 0 &&
      (orderedMessageIds.length === 0 ||
        orderedMessageIds.at(-1) === metadata.forkTarget.boundaryMessageId);
    if (!metadata.sourceCommandId.trim() || !validBoundary) {
      throw new Error("Fork child metadata is invalid");
    }

    // command key 是 (parentSessionId, sourceCommandId)；session_entry.id 是全库主键，
    // 必须把 parent 纳入 id，避免两个 session 恰好复用 commandId 时互相覆盖事实。
    const entryId = `v4_command_fact:child:${metadata.parentSessionId}:${metadata.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: input.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const childSessionId = forkChildSessionId(existing);
        if (!childSessionId) {
          throw new Error(`Fork child command fact is corrupt: ${entryId}`);
        }
        const child = sessionRepository.getSession(this.db, childSessionId);
        if (!child) {
          throw new Error(`Fork child session is missing: ${childSessionId}`);
        }
        this.db.exec("commit");
        return child;
      }

      const child = sessionRepository.createSession(this.db, input);
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: input.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: {
            commandId: metadata.sourceCommandId,
            status: "accepted",
            revisionAtDecision: 0,
            result: { type: "forkAssistant", sessionId: String(child.id) },
          },
          metadata,
        },
      });
      this.db.exec("commit");
      return child;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async commitForkBundle(bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { child, commandFact, initialInput } = bundle;
    if (
      !child.parentID ||
      String(child.parentID) !== commandFact.parentSessionId ||
      (initialInput && String(initialInput.sessionID) !== String(child.id)) ||
      commandFact.ack.commandId !== commandFact.sourceCommandId
    ) {
      throw new Error("Fork commit bundle identity is invalid");
    }
    const entryId = `v4_command_fact:child:${commandFact.parentSessionId}:${commandFact.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: child.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const existingChildId = forkChildSessionId(existing);
        const existingChild = existingChildId
          ? sessionRepository.getSession(this.db, existingChildId)
          : null;
        if (!existingChild) throw new Error(`Fork bundle command fact is corrupt: ${entryId}`);
        this.db.exec("commit");
        return existingChild;
      }

      assertForkBundleChildLocal(bundle);
      const persistedChild = sessionRepository.createSession(this.db, child);
      this.maybeThrowForkCommitFault("afterChild");
      for (const message of bundle.messages) {
        const messageSource = bundle.copySources?.messages[message.info.id];
        await messageRepository.saveMessage(
          this.db,
          message.info,
          messageSource ? { sessionID: child.parentID, id: messageSource } : undefined,
        );
        for (const part of message.parts) {
          const partSource = bundle.copySources?.parts[part.id];
          await messageRepository.savePart(
            this.db,
            part,
            partSource ? { sessionID: child.parentID, id: partSource } : undefined,
          );
        }
      }
      this.maybeThrowForkCommitFault("afterMessages");
      if (bundle.goal) {
        cloneSessionTargetForFork(this.db, {
          source: bundle.goal.source,
          sessionID: child.id,
          status: bundle.goal.status,
        });
      }
      this.maybeThrowForkCommitFault("afterGoal");
      for (const entry of bundle.entries) {
        sessionEntryRepository.saveSessionEntry(this.db, entry);
      }
      this.maybeThrowForkCommitFault("afterEntries");
      if (initialInput) {
        await sessionInputRepository.saveSessionInput(this.db, initialInput);
      }
      this.maybeThrowForkCommitFault("afterInput");
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: child.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: commandFact.ack,
          metadata: commandFact.metadata,
        },
      });
      this.maybeThrowForkCommitFault("afterCommandFact");
      this.maybeThrowForkCommitFault("beforeCommit");
      this.db.exec("commit");
      return persistedChild;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async commitSharedContextImportBundle(
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { session, contextMessage, provenance } = bundle;
    if (
      String(contextMessage.info.sessionID) !== String(session.id) ||
      String(provenance.sessionID) !== String(session.id) ||
      // session_entry.id 是全库主键，saveSessionEntry 的 on conflict(id)
      // 会把 session_id 改绑到后写入者。provenance id 若不含 session 命名空间，同一个
      // share 导入到第二个会话时会夺走第一个会话的条目（旧会话 transcript 静默丢失）。
      // 这里在唯一写入口做守卫，覆盖所有调用方，而不是只修某一个构造点。
      !provenance.id.includes(String(session.id)) ||
      contextMessage.info.role !== "user" ||
      contextMessage.info.visibility !== "model-only" ||
      contextMessage.info.source !== "shared_context"
    ) {
      throw new Error("Shared context import bundle identity is invalid");
    }
    this.db.exec("begin immediate");
    try {
      const existing = sessionRepository.getSession(this.db, session.id);
      if (existing) {
        const entry = sessionEntryRepository
          .sessionEntries(this.db, { sessionID: session.id, type: provenance.type })
          .find((candidate) => candidate.id === provenance.id);
        if (!entry) throw new Error("Shared context import session is incomplete");
        this.db.exec("commit");
        return existing;
      }
      const persisted = sessionRepository.createSession(this.db, session);
      await messageRepository.saveMessage(this.db, contextMessage.info);
      for (const part of contextMessage.parts) {
        await messageRepository.savePart(this.db, part);
      }
      sessionEntryRepository.saveSessionEntry(this.db, provenance);
      this.db.exec("commit");
      return persisted;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async transitionSharedContextImport(input: SharedContextImportTransition): Promise<boolean> {
    this.throwBeforeWrite();
    this.db.exec("begin immediate");
    try {
      const entry = sessionEntryRepository
        .sessionEntries(this.db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
        .find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === input.contextId,
          );
        });
      if (!entry) {
        this.db.exec("rollback");
        return false;
      }
      const data = entry.data as Record<string, unknown>;
      const expected = Array.isArray(input.expectedStatus)
        ? input.expectedStatus
        : [input.expectedStatus];
      if (!expected.includes(data.status as SharedContextImportTransition["status"])) {
        this.db.exec("rollback");
        return false;
      }
      sessionEntryRepository.saveSessionEntry(this.db, {
        ...entry,
        time: { ...entry.time, updated: Date.now() },
        data: {
          ...data,
          status: input.status,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
      });
      const contextMessage = (
        await messageRepository.messages(this.db, { sessionID: input.sessionID })
      ).find((message) => {
        const metadata = message.info.metadata;
        return Boolean(
          metadata &&
          typeof metadata === "object" &&
          (metadata as Record<string, unknown>).contextId === input.contextId,
        );
      });
      if (contextMessage) {
        await messageRepository.saveMessage(this.db, {
          ...contextMessage.info,
          metadata: {
            ...(contextMessage.info.metadata ?? {}),
            sharedContextStatus: input.status,
          },
        });
      }
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.updateSession(this.db, input);
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return sessionRepository.getSession(this.db, sessionID);
  }

  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    return sessionRepository.listSessions(this.db, input);
  }

  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    return sessionRepository.claimLegacySessionWorkspace(this.db, input);
  }

  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairLegacyRemoteSessionWorkspace(this.db, input);
  }

  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairRemoteSessionPaths(this.db, input);
  }

  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.saveMessage(this.db, input, copyFrom);
  }

  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removeMessage(this.db, input);
  }

  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.savePart(this.db, input, copyFrom);
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removePart(this.db, input);
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    return messageRepository.messageWithParts(this.db, input);
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return messageRepository.messages(this.db, input);
  }

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    return sessionEntryRepository.saveSessionEntry(this.db, input);
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]> {
    return sessionEntryRepository.sessionEntries(this.db, input);
  }

  // ── session_input 账本──

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.saveSessionInput(this.db, input);
  }

  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
  }

  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.updateSessionInputs(this.db, input);
  }

  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.promoteSessionInput(this.db, input);
  }

  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.markSessionInputPromoted(this.db, input);
  }

  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.settleSessionInput(this.db, input);
  }

  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    return sessionInputRepository.listSessionInputs(this.db, input);
  }

  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    return sessionInputRepository.getSessionInputById(this.db, id);
  }

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return todoRepository.readTodos(this.db, input);
  }

  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.throwBeforeWrite();
    return todoRepository.updateTodos(this.db, input);
  }

  async readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return readSessionTarget(this.db, input);
  }

  async setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal> {
    return setSessionTarget(this.db, {
      objective: input.objective,
      sessionID: input.sessionID,
      status: input.status ?? "active",
      tokenBudget: input.tokenBudget,
    });
  }

  async cloneTargetForFork(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal> {
    this.throwBeforeWrite();
    return cloneSessionTargetForFork(this.db, {
      source: input.source,
      sessionID: input.sessionID,
      status: input.status ?? input.source.status,
    });
  }

  async createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null> {
    return createSessionTarget(this.db, input);
  }

  async updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetStatus(this.db, input);
  }

  async startTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null> {
    return startSessionTargetRun(this.db, input);
  }

  async heartbeatTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null> {
    return heartbeatSessionTargetRun(this.db, input);
  }

  async finishTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null> {
    return finishSessionTargetRun(this.db, input);
  }

  async recoverInterruptedTargetRun(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return recoverInterruptedSessionTargetRun(this.db, input);
  }

  async accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null> {
    return accountSessionTargetUsage(this.db, input);
  }

  async updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetSummaryTitle(this.db, input);
  }

  async clearTarget(input: { sessionID: SessionId }): Promise<boolean> {
    return clearSessionTarget(this.db, input);
  }

  async recordModelUsage(input: ModelUsageRecord): Promise<void> {
    return usageRepository.recordModelUsage(this.db, input);
  }

  async upsertTurnUsage(input: TurnUsageRecord): Promise<void> {
    return usageRepository.upsertTurnUsage(this.db, input);
  }

  async upsertToolUsage(input: ToolUsageRecord): Promise<void> {
    return usageRepository.upsertToolUsage(this.db, input);
  }

  async pruneUsage(input?: { beforeTime?: number }): Promise<void> {
    return usageRepository.pruneUsage(this.db, input);
  }

  async queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult> {
    return usageRepository.queryAppUsage(this.db, input);
  }

  async queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult> {
    return usageRepository.queryTaskUsage(this.db, input);
  }

  async recordInputHistory(input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recordInputHistory(this.db, input);
  }

  async recallPreviousInputHistory(input: {
    projectID: ProjectId;
    skip?: number;
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recallPreviousInputHistory(this.db, input);
  }

  async getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null> {
    return localSettingsRepository.getProjectPermission(this.db, projectID);
  }

  async saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset> {
    return localSettingsRepository.saveProjectPermission(this.db, input);
  }

  getProjectPermissionMode(projectID: ProjectId): CollaborationMode | null {
    return localSettingsRepository.getProjectPermissionMode(this.db, projectID);
  }

  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode {
    return localSettingsRepository.saveProjectPermissionMode(this.db, input);
  }

  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    return sessionRepository.setRevert(this.db, input);
  }

  async clearRevert(sessionID: SessionId): Promise<void> {
    return sessionRepository.clearRevert(this.db, sessionID);
  }

  async upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord> {
    return scriptWorkflowRunRepository.upsertScriptWorkflowDefinition(this.db, input);
  }

  async createScriptWorkflowRun(
    input: CreateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.createScriptWorkflowRun(this.db, input);
  }

  async updateScriptWorkflowRun(
    input: UpdateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.updateScriptWorkflowRun(this.db, input);
  }

  async getScriptWorkflowRun(runId: string): Promise<ScriptWorkflowRunRecord | null> {
    return scriptWorkflowRunRepository.getScriptWorkflowRun(this.db, runId);
  }

  async listScriptWorkflowRuns(input?: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  }): Promise<ScriptWorkflowRunRecord[]> {
    return scriptWorkflowRunRepository.listScriptWorkflowRuns(this.db, input);
  }

  async createScriptWorkflowActivity(
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.createScriptWorkflowActivity(this.db, input);
  }

  async updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.updateScriptWorkflowActivity(this.db, input);
  }

  async findCachedScriptWorkflowActivity(input: {
    callPath: string;
    inputHash: string;
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord | null> {
    return scriptWorkflowActivityRepository.findCachedScriptWorkflowActivity(this.db, input);
  }

  async listScriptWorkflowActivities(input: {
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowActivities(this.db, input);
  }

  async appendScriptWorkflowEvent(input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  }): Promise<ScriptWorkflowEventRecord> {
    return scriptWorkflowActivityRepository.appendScriptWorkflowEvent(this.db, input);
  }

  async listScriptWorkflowEvents(input: {
    limit?: number;
    runId: string;
  }): Promise<ScriptWorkflowEventRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowEvents(this.db, input);
  }

  async createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<SessionTaskLinkRecord> {
    return scriptWorkflowActivityRepository.createSessionTaskLink(this.db, input);
  }

  /**
   * dynamic-workflow 执行引擎的 durable journal（dwf_* 表）。端口是同步的，所以这里返回
   * 端口对象本身而不是逐方法转发——引擎持有它、按自己的节奏读写。
   */
  workflowJournalStore(): JournalStorePort {
    this.dwfJournalStore ??= createDwfJournalStore(this.db);
    return this.dwfJournalStore;
  }

  debugMigrationIds(): string[] {
    return debugRepository.debugMigrationIds(this.db);
  }

  debugCounts(sessionID?: SessionId): SessionStoreDebugCounts {
    return debugRepository.debugCounts(this.db, sessionID);
  }
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export { getDefaultSessionDbPath };
