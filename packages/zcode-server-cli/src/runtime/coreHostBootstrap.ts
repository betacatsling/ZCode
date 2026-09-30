import { randomUUID } from "node:crypto";
import { chmod, constants, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { hostBootstrapTokenSchema, type ServerStatus } from "../contracts.js";
import type { ServerLayout } from "./paths.js";

/**
 * Version-skew fallback for the Host bootstrap secret
 * (docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md, "Migration and compatibility").
 *
 * A pre-M2 Supervisor parses the Core `ready` IPC message with a schema that strips
 * `hostBootstrapToken`, so after an in-place Core update its status never carries the secret and
 * the new Core answers 401. The Core therefore also writes `run/core-host-bootstrap.json`
 * (0600, runDir 0700, atomic rename). The new CLI merges it into `serve/status --json` only when
 * the Supervisor status lacks the secret and the record matches the running Core exactly.
 */
export const coreHostBootstrapRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
    host: z.string().min(1),
    port: z.number().int().positive(),
    hostBootstrapToken: hostBootstrapTokenSchema,
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type CoreHostBootstrapRecord = z.infer<typeof coreHostBootstrapRecordSchema>;

/** The record is ~150 bytes; anything much larger is not ours. */
const MAX_RECORD_BYTES = 4096;

export async function writeCoreHostBootstrapFile(
  layout: Pick<ServerLayout, "runDir" | "coreHostBootstrapFile">,
  record: Omit<CoreHostBootstrapRecord, "schemaVersion" | "createdAt">,
  now: () => number = Date.now,
): Promise<void> {
  const content = coreHostBootstrapRecordSchema.parse({
    schemaVersion: 1,
    ...record,
    createdAt: now(),
  });
  await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
  // A pre-M2 Supervisor never tightens an existing runDir; the secret must not sit in a
  // group/other-traversable directory.
  if (process.platform !== "win32") await chmod(layout.runDir, 0o700);
  const temporary = `${layout.coreHostBootstrapFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(content)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    // umask can only drop bits; chmod makes the mode exactly 0600 so the reader's check holds.
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, layout.coreHostBootstrapFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Removes the file only while it still describes this Core, so a newer generation's file survives. */
export async function removeCoreHostBootstrapFile(
  layout: Pick<ServerLayout, "coreHostBootstrapFile">,
  owner: Pick<CoreHostBootstrapRecord, "generation" | "pid">,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(layout.coreHostBootstrapFile, "utf8");
  } catch {
    return;
  }
  let parsed: CoreHostBootstrapRecord;
  try {
    parsed = coreHostBootstrapRecordSchema.parse(JSON.parse(raw));
  } catch {
    return;
  }
  if (parsed.generation !== owner.generation || parsed.pid !== owner.pid) return;
  await rm(layout.coreHostBootstrapFile, { force: true });
}

export type CoreHostBootstrapFileRead =
  | { state: "valid"; record: CoreHostBootstrapRecord }
  | { state: "missing" }
  | {
      state: "rejected";
      reason:
        | "not-regular-file"
        | "insecure-permissions"
        | "foreign-owner"
        | "malformed"
        | "unreadable";
    };

export async function readCoreHostBootstrapFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<CoreHostBootstrapFileRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NOFOLLOW: a symlink planted at the path must not redirect the read; fstat on the opened
    // handle then checks the exact inode that is read (no lstat/read race).
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { state: "missing" };
    if (code === "ELOOP") return { state: "rejected", reason: "not-regular-file" };
    return { state: "rejected", reason: "unreadable" };
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) {
      return { state: "rejected", reason: "not-regular-file" };
    }
    if (platform !== "win32") {
      if ((stats.mode & 0o777) !== 0o600)
        return { state: "rejected", reason: "insecure-permissions" };
      const uid = process.getuid?.();
      if (uid !== undefined && stats.uid !== uid)
        return { state: "rejected", reason: "foreign-owner" };
    }
    const raw = await handle.readFile("utf8");
    const parsed = coreHostBootstrapRecordSchema.safeParse(safeJsonParse(raw));
    if (!parsed.success) return { state: "rejected", reason: "malformed" };
    return { state: "valid", record: parsed.data };
  } catch {
    return { state: "rejected", reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export type CoreHostBootstrapResolution =
  | { merged: true; hostBootstrapToken: string }
  | {
      merged: false;
      reason:
        | "supervisor-token"
        | "core-not-ready"
        | "file-missing"
        | "file-rejected"
        | "stale-record"
        | "core-not-running";
      detail?: string;
    };

export interface CoreHostBootstrapResolveOptions {
  platform?: NodeJS.Platform;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Decides whether the Core-written secret may fill a Supervisor status that lacks one.
 * A Supervisor-provided secret always wins; the record must match the running Core's generation,
 * pid, host and port, and that pid must be alive.
 */
export async function resolveCoreHostBootstrapToken(
  status: ServerStatus,
  layout: Pick<ServerLayout, "coreHostBootstrapFile">,
  options: CoreHostBootstrapResolveOptions = {},
): Promise<CoreHostBootstrapResolution> {
  if (status.hostBootstrapToken) return { merged: false, reason: "supervisor-token" };
  if (
    status.state !== "ready" ||
    status.pid === null ||
    status.port === null ||
    status.host === null
  ) {
    return { merged: false, reason: "core-not-ready" };
  }
  const read = await readCoreHostBootstrapFile(layout.coreHostBootstrapFile, options.platform);
  if (read.state === "missing") return { merged: false, reason: "file-missing" };
  if (read.state === "rejected")
    return { merged: false, reason: "file-rejected", detail: read.reason };
  const { record } = read;
  if (
    record.generation !== status.generation ||
    record.pid !== status.pid ||
    record.port !== status.port ||
    record.host !== status.host
  ) {
    return { merged: false, reason: "stale-record" };
  }
  if (!(options.isProcessAlive ?? isProcessAlive)(record.pid)) {
    return { merged: false, reason: "core-not-running" };
  }
  return { merged: true, hostBootstrapToken: record.hostBootstrapToken };
}

/** Returns `status` unchanged unless the Core-written secret passes every check above. */
export async function mergeCoreHostBootstrapToken<T extends ServerStatus>(
  status: T,
  layout: Pick<ServerLayout, "coreHostBootstrapFile">,
  options: CoreHostBootstrapResolveOptions = {},
): Promise<T> {
  const resolution = await resolveCoreHostBootstrapToken(status, layout, options);
  return resolution.merged
    ? { ...status, hostBootstrapToken: resolution.hostBootstrapToken }
    : status;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: alive but owned by another user, so it cannot be our Core (fail closed).
    return false;
  }
}
