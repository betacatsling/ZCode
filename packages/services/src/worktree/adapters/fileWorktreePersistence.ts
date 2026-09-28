import { readFile } from "node:fs/promises";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { WorktreeCatalogFile, WorktreePersistence } from "../contract.js";

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readRaw(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export function createFileWorktreePersistence(filePath: string): WorktreePersistence {
  return {
    read: () => withFileLock(filePath, () => readRaw(filePath)),
    update: (mutator: (current: unknown | null) => WorktreeCatalogFile) =>
      withFileLock(filePath, async () => {
        const next = mutator(await readRaw(filePath));
        await atomicWritePrivateTextFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
        return next;
      }),
  };
}
