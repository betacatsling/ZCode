import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLegacyZCodeSession } from "../sessionRouter.js";
import { assertIsolatedDrillRoot } from "./drillRoot.js";

function nativePath(root: string): string {
  return join(assertIsolatedDrillRoot(root), "native-sessions.json");
}

function backupPath(root: string): string {
  return `${nativePath(root)}.bak`;
}

export function nativeSessionsPath(root: string): string {
  return nativePath(root);
}

export function externalSessionsPath(root: string): string {
  return join(assertIsolatedDrillRoot(root), "external-sessions.json");
}

async function readArray(path: string): Promise<unknown[]> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("session-file-must-be-array");
  return parsed;
}

async function writeArray(path: string, records: readonly unknown[]): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

/** 先整批校验再写。失败时不替换已有原生文件。 */
export async function writeNativeSessions(
  root: string,
  records: readonly unknown[],
): Promise<void> {
  for (const record of records) {
    const read = readLegacyZCodeSession(record);
    // 旧程序把没有 sidecar 的记录当成原生 zcode。外部记录不能进入这个文件。
    if (read.kind !== "native") throw new Error("external-session-not-native");
  }
  await writeArray(nativePath(root), records);
}

export async function readNativeSessions(root: string): Promise<unknown[]> {
  return readArray(nativePath(root));
}

export async function backupNativeSessions(root: string): Promise<void> {
  const source = nativePath(root);
  await readArray(source);
  await copyFile(source, backupPath(root));
}

export async function writeExternalSidecar(
  root: string,
  records: readonly unknown[],
): Promise<void> {
  for (const record of records) {
    const read = readLegacyZCodeSession(record);
    if (read.kind !== "external") throw new Error("external-sidecar-requires-metadata");
  }
  await writeArray(externalSessionsPath(root), records);
}

export async function readExternalSidecar(root: string): Promise<unknown[]> {
  return readArray(externalSessionsPath(root));
}

/** 用备份覆盖原生文件。sidecar 仍只被分类为外部，不进入原生重放。 */
export async function rollbackNativeSessions(root: string): Promise<void> {
  await copyFile(backupPath(root), nativePath(root));
}
