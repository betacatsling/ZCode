import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export interface JournalIdentity {
  targetId: string;
  workspaceIdentity: string;
  harnessId: string;
  hostSessionId: string;
  runtimeEpoch: string;
}

/** Hash all identity segments; never interpolate backend/user IDs into filesystem paths. */
export function journalPath(root: string, identity: JournalIdentity, kind: string): string {
  const digest = createHash("sha256").update(JSON.stringify([
    identity.targetId, identity.workspaceIdentity, identity.harnessId,
    identity.hostSessionId, identity.runtimeEpoch,
  ])).digest("hex");
  return join(root, `${digest}.${kind}.jsonl`);
}

async function tryTakeLock(path: string): Promise<FileHandle> {
  const lock = await open(path, "wx", 0o600);
  await lock.writeFile(`${process.pid}\n`);
  await lock.sync();
  return lock;
}

async function committedBytes(path: string): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(`${path}.cursor`, "utf8")) as { version?: number; bytes?: number };
    if (value.version !== 1 || !Number.isSafeInteger(value.bytes) || value.bytes! < 0) throw new Error("invalid journal commit cursor");
    return value.bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function journalCommittedBytes(path: string): Promise<number | undefined> {
  return committedBytes(path);
}

async function publishCursor(path: string, bytes: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, bytes })); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, `${path}.cursor`);
}

export async function readJournalLines(path: string): Promise<string[]> {
  const bytes = await committedBytes(path);
  let raw: Buffer;
  try { raw = await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && bytes === undefined) return [];
    throw error;
  }
  if (bytes !== undefined && bytes > raw.length) throw new Error("journal shorter than committed cursor");
  const prefix = (bytes === undefined ? raw : raw.subarray(0, bytes)).toString("utf8");
  if (prefix && !prefix.endsWith("\n")) throw new Error("truncated journal tail; inspect before reading history");
  return prefix ? prefix.slice(0, -1).split("\n") : [];
}

export async function openJournal(root: string, path: string): Promise<{ file: FileHandle; lock: FileHandle; lockPath: string; lines: string[] }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock: FileHandle;
  try {
    lock = await tryTakeLock(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid journal owner lock");
    try {
      process.kill(pid, 0);
      throw new Error("journal already has a live owner");
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
    }
    await unlink(lockPath);
    lock = await tryTakeLock(lockPath);
  }
  let file: FileHandle | undefined;
  try {
    file = await open(path, "a+", 0o600);
    const raw = await file.readFile();
    const committed = await committedBytes(path);
    // 修复崩溃后未提交的尾部被再次追加：必须人工确认，不能自动截断或重放。
    if (committed !== undefined && committed !== raw.length) throw new Error("uncommitted journal tail; inspect before admitting commands");
    const text = raw.toString("utf8");
    if (text && !text.endsWith("\n")) throw new Error("truncated journal tail; inspect before admitting commands");
    if (committed === undefined) await publishCursor(path, raw.length);
    return { file, lock, lockPath, lines: text ? text.slice(0, -1).split("\n") : [] };
  } catch (error) {
    await file?.close();
    await lock.close();
    await unlink(lockPath);
    throw error;
  }
}

export async function closeJournal(file: FileHandle, lock: FileHandle, lockPath: string): Promise<void> {
  await file.close();
  await lock.close();
  await unlink(lockPath);
}

export async function durableAppend(file: FileHandle, path: string, row: unknown): Promise<void> {
  await file.appendFile(`${JSON.stringify(row)}\n`, "utf8");
  await file.sync();
  // 修复只读并发读到 fsync 前半行：提交游标始终最后发布。
  await publishCursor(path, (await file.stat()).size);
}
