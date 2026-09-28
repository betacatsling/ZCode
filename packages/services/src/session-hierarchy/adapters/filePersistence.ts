import { readFile, rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  sessionHierarchyFileSchema,
  sessionHierarchyRollbackRecordSchema,
} from "@zcode/shared/agent-host/session-hierarchy";
import type { SessionHierarchyPersistence } from "../contract.js";

export function createSessionHierarchyFilePersistence(
  filePath: string,
): SessionHierarchyPersistence {
  return {
    async read() {
      try {
        return JSON.parse(await readFile(filePath, "utf8")) as unknown;
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }
    },
    async update(mutator) {
      return withFileLock(filePath, async () => {
        const raw = await this.read();
        const next = await mutator(raw);
        const current = raw === null ? null : sessionHierarchyFileSchema.parse(raw);
        if (current !== null && isDeepStrictEqual(current, next)) return current;
        const backupPath = `${filePath}.bak`;
        const previousBackup = await readFile(backupPath, "utf8").catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        });
        const rollbackRecord = {
          schemaVersion: 1 as const,
          appliedRevision: next.source.commandKey,
          previous: current,
        };
        try {
          await atomicWritePrivateTextFile(
            backupPath,
            `${JSON.stringify(rollbackRecord, null, 2)}\n`,
          );
          await atomicWritePrivateTextFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
        } catch (error) {
          if (raw === null) await rm(filePath, { force: true });
          else await atomicWritePrivateTextFile(filePath, `${JSON.stringify(raw, null, 2)}\n`);
          if (previousBackup === null) await rm(backupPath, { force: true });
          else await atomicWritePrivateTextFile(backupPath, previousBackup);
          throw error;
        }
        return next;
      });
    },
    async rollback(expectedCurrentRevision) {
      return withFileLock(filePath, async () => {
        const currentRaw = await this.read();
        if (currentRaw === null) throw new Error("session-hierarchy-no-current-sidecar");
        const current = sessionHierarchyFileSchema.parse(currentRaw);
        if (current.source.commandKey !== expectedCurrentRevision)
          throw new Error("stale-session-hierarchy-baseline");
        const backupRaw = await readFile(`${filePath}.bak`, "utf8").catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        });
        if (backupRaw === null) throw new Error("session-hierarchy-no-backup");
        const rollbackRecord = sessionHierarchyRollbackRecordSchema.parse(
          JSON.parse(backupRaw) as unknown,
        );
        if (
          rollbackRecord.appliedRevision !== expectedCurrentRevision ||
          current.source.commandKey !== expectedCurrentRevision
        )
          throw new Error("stale-session-hierarchy-baseline");
        if (rollbackRecord.previous === null) await rm(filePath, { force: true });
        else
          await atomicWritePrivateTextFile(
            filePath,
            `${JSON.stringify(rollbackRecord.previous, null, 2)}\n`,
          );
        return rollbackRecord.previous;
      });
    },
  };
}
