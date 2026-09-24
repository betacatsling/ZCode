import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
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

export async function readJournalLines(path: string): Promise<string[]> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (raw && !raw.endsWith("\n")) throw new Error("truncated journal tail; inspect before reading history");
  return raw ? raw.trimEnd().split("\n") : [];
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
  try {
    const file = await open(path, "a+", 0o600);
    const raw = await file.readFile("utf8");
    const lines = raw ? raw.trimEnd().split("\n") : [];
    if (raw && !raw.endsWith("\n")) {
      await file.close();
      throw new Error("truncated journal tail; inspect before admitting commands");
    }
    return { file, lock, lockPath, lines };
  } catch (error) {
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

export async function durableAppend(file: FileHandle, row: unknown): Promise<void> {
  await file.appendFile(`${JSON.stringify(row)}\n`, "utf8");
  await file.sync();
}
