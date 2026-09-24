import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  type NativeCreateReceipt,
  type SessionInfo,
} from "@zcode/contracts";
import { decodeSessionEntryRow, decodeSessionRow } from "./codecs.js";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import type { SessionEntryRow, SessionRow } from "./rows.js";

export interface NativeStoredSessionMetadata {
  session: SessionInfo;
  /** undefined means no selection entry; malformed explicit selection is retained as unknown. */
  lastSelection?: unknown;
  hasSelectionEntry: boolean;
}

/** Path must be resolved by the native bootstrap's getSessionDbPath(config, cwd), never guessed here. */
export class ReadonlyNativeSessionMetadataView {
  constructor(private readonly resolvedDbPath: string) {
    if (!isAbsolute(resolvedDbPath)) throw new Error("native-db-path-must-be-resolved");
  }

  /** Exact DB + scope validation. Missing/partial/unsupported databases never become a creation fact. */
  async readCreateReceipt(
    commandId: string,
    workspaceScope: string,
  ): Promise<(NativeCreateReceipt & { nativeDatabasePath: string }) | undefined> {
    if (!commandId || !workspaceScope) return undefined;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.resolvedDbPath, { readOnly: true });
      this.assertSupportedSchema(db);
      const row = db
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
      if (
        !row ||
        row.workspace_scope !== workspaceScope ||
        !/^[a-f0-9]{64}$/.test(row.intent_fingerprint) ||
        ![0, 1].includes(row.has_first_input) ||
        row.status !== "completed"
      )
        return undefined;
      const session = db.prepare("select * from session where id = ?").get(row.session_id) as
        | SessionRow
        | undefined;
      if (!session || (session.workspace_id ?? session.directory) !== workspaceScope)
        return undefined;
      if (row.has_first_input === 1) {
        const input = db
          .prepare(`select status,
            json_extract(payload, '$.sourceCommandType') as source_type,
            json_extract(payload, '$.conversationInputIntent.sourceCommandId') as source_id
            from session_input where id = ? and session_id = ?`)
          .get(`queue_${commandId}`, row.session_id) as
          | { status: string; source_type: string | null; source_id: string | null }
          | undefined;
        if (
          input?.status !== "promoted" ||
          input.source_type !== "createSession" ||
          input.source_id !== commandId
        )
          return undefined;
      }
      return {
        commandId: row.command_id,
        originalSessionId: row.session_id as NativeCreateReceipt["originalSessionId"],
        workspaceScope: row.workspace_scope,
        intentFingerprint: row.intent_fingerprint,
        hasFirstInput: row.has_first_input === 1,
        status: row.status as NativeCreateReceipt["status"],
        nativeDatabasePath: this.resolvedDbPath,
      };
    } catch {
      return undefined;
    } finally {
      db?.close();
    }
  }

  private assertSupportedSchema(db: DatabaseSync): void {
    const ledger = db
      .prepare("SELECT id, checksum FROM schema_migration ORDER BY id")
      .all() as Array<{
      id: string;
      checksum: string;
    }>;
    const expected = [...SQLITE_MIGRATIONS].sort((a, b) => a.id.localeCompare(b.id));
    if (
      Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) !==
        0 ||
      ledger.length !== expected.length ||
      expected.some(
        (migration, i) =>
          ledger[i]?.id !== migration.id ||
          ledger[i]?.checksum !== createHash("sha256").update(migration.sql.trim()).digest("hex"),
      )
    )
      throw new Error("unknown-native-session-schema");
    for (const [table, required] of [
      [
        "session",
        [
          "id",
          "project_id",
          "workspace_id",
          "slug",
          "directory",
          "title",
          "version",
          "time_created",
          "time_updated",
        ],
      ],
      ["session_entry", ["id", "session_id", "type", "time_created", "time_updated", "data"]],
      [
        "native_create_receipt",
        [
          "command_id",
          "session_id",
          "workspace_scope",
          "intent_fingerprint",
          "has_first_input",
          "status",
        ],
      ],
    ] as const) {
      const names = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      if (required.some((column) => !names.has(column)))
        throw new Error("unknown-native-session-schema");
    }
  }

  async read(nativeSessionId: string): Promise<NativeStoredSessionMetadata | undefined> {
    // Read-only SQLite sees committed WAL transactions; it neither initializes nor upgrades the CLI DB.
    const db = new DatabaseSync(this.resolvedDbPath, { readOnly: true });
    try {
      this.assertSupportedSchema(db);
      const row = db.prepare("SELECT * FROM session WHERE id = ?").get(nativeSessionId) as
        | SessionRow
        | undefined;
      if (!row) return undefined;
      const entry = db
        .prepare(
          "SELECT * FROM session_entry WHERE session_id = ? AND type = ? ORDER BY time_created DESC, rowid DESC LIMIT 1",
        )
        .get(nativeSessionId, SESSION_ENTRY_MODEL_SELECTION) as SessionEntryRow | undefined;
      const decoded = entry ? decodeSessionEntryRow(entry) : undefined;
      return {
        session: decodeSessionRow(row),
        hasSelectionEntry: !!entry,
        ...(entry ? { lastSelection: decoded?.data } : {}),
      };
    } finally {
      db.close();
    }
  }
}
