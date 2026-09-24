import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SESSION_ENTRY_MODEL_SELECTION, type SessionInfo } from "@zcode/contracts";
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

  async read(nativeSessionId: string): Promise<NativeStoredSessionMetadata | undefined> {
    // Read-only SQLite sees committed WAL transactions; it neither initializes nor upgrades the CLI DB.
    const db = new DatabaseSync(this.resolvedDbPath, { readOnly: true });
    try {
      const ledger = db.prepare("SELECT id, checksum FROM schema_migration ORDER BY id").all() as Array<{
        id: string;
        checksum: string;
      }>;
      const expected = [...SQLITE_MIGRATIONS].sort((a, b) => a.id.localeCompare(b.id));
      if (
        Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) !== 0 ||
        ledger.length !== expected.length ||
        expected.some((migration, i) =>
          ledger[i]?.id !== migration.id ||
          ledger[i]?.checksum !== createHash("sha256").update(migration.sql.trim()).digest("hex"),
        )
      ) throw new Error("unknown-native-session-schema");
      for (const [table, required] of [
        ["session", ["id", "project_id", "workspace_id", "slug", "directory", "title", "version", "time_created", "time_updated"]],
        ["session_entry", ["id", "session_id", "type", "time_created", "time_updated", "data"]],
      ] as const) {
        const names = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
        );
        if (required.some((column) => !names.has(column))) throw new Error("unknown-native-session-schema");
      }
      const row = db.prepare("SELECT * FROM session WHERE id = ?").get(nativeSessionId) as SessionRow | undefined;
      if (!row) return undefined;
      const entry = db.prepare(
        "SELECT * FROM session_entry WHERE session_id = ? AND type = ? ORDER BY time_created DESC, rowid DESC LIMIT 1",
      ).get(nativeSessionId, SESSION_ENTRY_MODEL_SELECTION) as SessionEntryRow | undefined;
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
