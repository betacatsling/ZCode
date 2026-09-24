import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  parseModelSelectionValue,
  SESSION_ENTRY_MODEL_SELECTION,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { modelBindingRequestSchema, type ModelBindingRequest } from "@zcode/shared/agent-host";
import {
  legacyExportSchema,
  type LegacyBackup,
  type LegacyExport,
  type LegacyPersistentSessionIndexReader,
  type LegacyRecord,
} from "../project-workspaces/migrationContract.js";
import { areTasksDatabaseMigrationsApplied } from "./tasksDatabase/migrations.js";

/** Native CLI session-store metadata, obtained through a public native-owner read API (no transcript copy). */
export interface NativeSessionMetadataReader {
  read(scope: { workspaceKey: string; workspacePath: string; nativeSessionId: string }): Promise<
    | {
        cwd: string;
        targetId: string;
        modelBinding?: ModelBindingRequest;
        /** A malformed explicit native selection must never fall back to the stale task-index model. */
        suppressIndexModelFallback?: boolean;
      }
    | undefined
  >;
}

/** Binds an already-open native session owner to the index, without opening/migrating its DB. */
export class NativeSessionStoreMetadataReader implements NativeSessionMetadataReader {
  constructor(
    private readonly store: Pick<SessionStorePort, "getSession" | "sessionEntries">,
    private readonly targetForScope: (scope: {
      workspaceKey: string;
      workspacePath: string;
      nativeSessionId: string;
    }) => Promise<string | undefined>,
  ) {}

  async read(scope: { workspaceKey: string; workspacePath: string; nativeSessionId: string }) {
    const sessionId = scope.nativeSessionId as SessionId;
    const session = await this.store.getSession(sessionId);
    if (!session || !isAbsolute(session.directory) || !isAbsolute(scope.workspacePath))
      return undefined;
    const child = relative(scope.workspacePath, session.directory);
    // 中文：SessionStore 的 id 是全库主键；同名 task 在另一个原生 scope 下不能被误认领。
    if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined;
    if (isRemoteWorkspaceIdentity(scope.workspaceKey) && session.workspaceID !== scope.workspaceKey)
      return undefined;
    const targetId = await this.targetForScope(scope);
    if (!targetId) return undefined;
    const entries = await this.store.sessionEntries?.({
      sessionID: sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
    });
    const lastSelection = entries?.at(-1);
    const parsed = lastSelection ? parseModelSelectionValue(lastSelection.data) : undefined;
    return {
      cwd: session.directory,
      targetId,
      ...(parsed
        ? {
            modelBinding: modelBindingRequestSchema.parse({
              kind: "host-managed",
              selection: parsed,
            }),
          }
        : {}),
      ...(lastSelection && !parsed ? { suppressIndexModelFallback: true } : {}),
    };
  }
}

const expectedColumns = [
  "workspace_key",
  "workspace_path",
  "workspace_identity",
  "task_id",
  "title",
  "task_status",
  "provider",
  "mode",
  "model",
  "migration_source",
  "forked_from_task_id",
  "cron_automation_id",
  "off_peak_task_id",
  "created_at",
  "updated_at",
  "unread_at",
  "last_unread_at",
  "pinned",
  "archived",
  "deleted",
  "title_overridden",
  "searchable_text",
  "meta_json",
];
export interface NativeIndexFact {
  workspaceKey: string;
  nativeSessionId: string;
  title: string;
  updatedAt: number;
  status: string | null;
  archived: boolean;
  deleted: boolean;
  unread: boolean;
  waiting: boolean;
  nativeModel: string | null;
  /** Only unambiguous last-observed selection; native session store owns actual active selection. */
  lastObservedModelBinding?: ModelBindingRequest;
}
interface RawRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  provider: string | null;
  model: string | null;
  meta_json: string;
  [column: string]: string | number | null;
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

/** No schema upgrade is performed on this read-only migration path. */
function readRaw(path: string): { revision: string; rows: RawRow[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (
      Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) !==
      0
    )
      throw new Error("unknown-native-schema");
    if (!areTasksDatabaseMigrationsApplied(db)) throw new Error("unmigrated-native-schema");
    const ledger = db.prepare("SELECT id FROM tasks_schema_migration ORDER BY id").all() as Array<{
      id: string;
    }>;
    if (
      ledger.map(({ id }) => id).join(",") !==
      "0001_adopt_task_schema,0002_provider_selection,0003_official_glm_selection"
    )
      throw new Error("unknown-native-schema");
    const columns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
      ({ name }) => name,
    );
    if (
      columns.length !== expectedColumns.length ||
      expectedColumns.some((name) => !columns.includes(name))
    )
      throw new Error("unknown-native-schema");
    const rows = db
      .prepare("SELECT * FROM tasks ORDER BY workspace_key, task_id")
      .all() as unknown as RawRow[];
    const revision = hash(JSON.stringify({ ledger, columns, rows }));
    return { revision, rows };
  } finally {
    db.close();
  }
}

function indexModel(model: string | null, thoughtLevel: unknown): ModelBindingRequest | undefined {
  // 中文：V4 把 selection 序列化为 providerId/modelId；含多个斜线时无法无损反解，应等待原生元数据而不是猜 provider。
  if (
    !model ||
    model.split("/").length !== 2 ||
    (thoughtLevel !== undefined && (typeof thoughtLevel !== "string" || !thoughtLevel.trim()))
  )
    return undefined;
  const [providerId, modelId] = model.split("/");
  const selection = {
    providerId,
    modelId,
    ...(typeof thoughtLevel === "string" && thoughtLevel.trim()
      ? { options: { reasoningLevel: thoughtLevel } }
      : {}),
  };
  const parsed = modelBindingRequestSchema.safeParse({ kind: "host-managed", selection });
  return parsed.success ? parsed.data : undefined;
}

export class NativePersistentSessionIndex implements LegacyPersistentSessionIndexReader {
  constructor(
    private readonly databasePath: string,
    private readonly backupDirectory: string,
    private readonly profileId: string,
    private readonly metadata: NativeSessionMetadataReader,
  ) {}

  private backupPath(id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("invalid-native-backup-id");
    return join(this.backupDirectory, `${id}.sqlite`);
  }

  private async snapshot<T>(action: (path: string) => Promise<T>): Promise<T> {
    await mkdir(this.backupDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.backupDirectory, `.${randomUUID()}.snapshot.sqlite`);
    const db = new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      // 中文：原生索引采用 WAL；只复制主文件可能丢失已提交的事务，必须用 SQLite 在线备份 API。
      await backup(db, path);
      return await action(path);
    } finally {
      db.close();
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  /** Current native-owner facts for catalog read projection; never use migrated metadata as runtime truth. */
  readFacts(): Promise<NativeIndexFact[]> {
    return this.snapshot(async (path) => {
      const { rows } = readRaw(path);
      return rows.map((row) => {
        let pendingInteraction: unknown;
        let thoughtLevel: unknown;
        try {
          const metadata = JSON.parse(row.meta_json) as {
            pendingInteraction?: unknown;
            thoughtLevel?: unknown;
          };
          pendingInteraction = metadata.pendingInteraction;
          thoughtLevel = metadata.thoughtLevel;
        } catch {
          // 中文：损坏的原生 meta 不能被当作缺省选项，也不能凭旧索引猜测执行状态。
          thoughtLevel = null;
        }
        const lastObservedModelBinding = indexModel(row.model, thoughtLevel);
        return {
          workspaceKey: row.workspace_key,
          nativeSessionId: row.task_id,
          title: String(row.title),
          updatedAt: Number(row.updated_at),
          status: typeof row.task_status === "string" ? row.task_status : null,
          archived: row.archived === 1,
          deleted: row.deleted === 1,
          unread: row.unread_at !== null,
          waiting: pendingInteraction !== undefined,
          nativeModel: row.model,
          ...(lastObservedModelBinding ? { lastObservedModelBinding } : {}),
        };
      });
    });
  }

  private async exportSnapshot(path: string): Promise<LegacyExport> {
    const { revision, rows } = readRaw(path);
    const records: LegacyRecord[] = [];
    for (const row of rows) {
      if (
        !row.workspace_key ||
        !row.workspace_path ||
        !row.task_id ||
        (!isRemoteWorkspaceIdentity(row.workspace_key) &&
          row.workspace_key !== (row.workspace_identity?.trim() || row.workspace_path))
      )
        throw new Error("invalid-native-scope");
      let thoughtLevel: unknown;
      try {
        thoughtLevel = (JSON.parse(row.meta_json) as { thoughtLevel?: unknown }).thoughtLevel;
      } catch {
        // 中文：meta_json 不能解析时不能将丢失的推理选项伪装为用户未选择。
        thoughtLevel = null;
      }
      const native = await this.metadata.read({
        workspaceKey: row.workspace_key,
        workspacePath: row.workspace_path,
        nativeSessionId: row.task_id,
      });
      const binding =
        native?.modelBinding ??
        (native?.suppressIndexModelFallback ? undefined : indexModel(row.model, thoughtLevel));
      records.push({
        id: JSON.stringify([row.workspace_key, row.task_id]),
        nativeSessionId: row.task_id,
        workspaceKey: row.workspace_key,
        workspacePath: row.workspace_path,
        ...(isRemoteWorkspaceIdentity(row.workspace_key)
          ? { workspaceIdentity: row.workspace_key }
          : row.workspace_identity
            ? { workspaceIdentity: row.workspace_identity }
            : {}),
        ...(row.provider ? { nativeProvider: row.provider } : {}),
        ...(row.model ? { nativeModel: row.model } : {}),
        ...(typeof thoughtLevel === "string" ? { nativeThoughtLevel: thoughtLevel } : {}),
        ...(native?.targetId ? { targetId: native.targetId } : {}),
        // Native scope can be a subdirectory or a remote routing key. Only native owner may attest exact cwd.
        ...(native?.cwd ? { nativeCwd: native.cwd } : {}),
        ...(native?.cwd === row.workspace_path ? { cwdRelativeToWorktree: "." } : {}),
        harnessId: "zcode",
        ...(binding ? { modelBinding: modelBindingRequestSchema.parse(binding) } : {}),
      });
    }
    return {
      sourceSchemaVersion: 3,
      profileId: this.profileId,
      revision,
      checksum: revision,
      records,
    };
  }

  exportAll(): Promise<LegacyExport> {
    return this.snapshot((path) => this.exportSnapshot(path));
  }

  async backup(exported: LegacyExport): Promise<LegacyBackup> {
    return this.snapshot(async (path) => {
      const current = await this.exportSnapshot(path);
      if (
        JSON.stringify(legacyExportSchema.parse(current)) !==
        JSON.stringify(legacyExportSchema.parse(exported))
      )
        throw new Error("legacy-index-changed");
      const backupId = hash(await readFile(path));
      const destination = this.backupPath(backupId);
      const file = await open(path, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(path, destination);
      const directory = await open(dirname(destination), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return {
        sourceSchemaVersion: current.sourceSchemaVersion,
        profileId: current.profileId,
        revision: current.revision,
        checksum: current.checksum,
        backupId,
      };
    });
  }

  async verifyBackup(record: LegacyBackup): Promise<boolean> {
    try {
      const path = this.backupPath(record.backupId);
      if (hash(await readFile(path)) !== record.backupId) return false;
      const raw = readRaw(path);
      return (
        record.sourceSchemaVersion === 3 &&
        record.profileId === this.profileId &&
        record.revision === raw.revision &&
        record.checksum === raw.revision
      );
    } catch {
      return false;
    }
  }
}
