import { DatabaseSync } from "node:sqlite";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

/** Read the real isolated CLI SQLite store; never write synthetic accepted command facts. */
export function countNativeSessions(): number {
  const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!, { readOnly: true });
  try {
    return (db.prepare("select count(*) as total from session").get() as { total: number }).total;
  } finally {
    db.close();
  }
}

/** Wait for the real CLI's early V4 ACK without treating elapsed time as execution evidence. */
export async function waitForEarlyAck(
  path: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const read = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const existing = await read();
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    let settled = false;
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename?.toString() !== basename(path)) return;
      void read().then((value) => {
        if (value) settle(undefined, value);
      }, settle);
    });
    const timer = setTimeout(
      () => settle(new Error("actual CLI early-command ACK deadline")),
      timeoutMs,
    );
    const settle = (error?: Error | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve(value!);
    };
    // Close the check/watch race without using a sleep to infer command progress.
    void read().then((value) => {
      if (value) settle(undefined, value);
    }, settle);
  });
}
