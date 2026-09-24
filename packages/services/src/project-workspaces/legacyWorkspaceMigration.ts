import { z } from "zod";
import { cwdRelativeToWorktreeSchema } from "@zcode/shared/agent-host";
import { repositoryBindingSchema, worktreeWorkspaceSchema } from "@zcode/shared/project-workspaces";
import { ProfileFileOwner } from "./profilePersistence.js";
import {
  legacyExportSchema,
  legacyBackupSchema,
  mappingSchema,
  type LegacyMapping,
  type LegacyBackup,
  type LegacyExport,
  type LegacyPersistentSessionIndexReader,
  type LegacyTargetResolver,
  type MigrationPreview,
} from "./migrationContract.js";
export { legacyRecordSchema, legacyExportSchema, legacyBackupSchema } from "./migrationContract.js";
export type {
  LegacyRecord,
  LegacyExport,
  LegacyBackup,
  LegacyMapping,
  LegacyPersistentSessionIndexReader,
  LegacyTargetResolver,
  MigrationPreview,
} from "./migrationContract.js";
const migrationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: legacyBackupSchema,
  mappings: z.array(mappingSchema),
});
function sameSource(a: LegacyBackup, b: LegacyExport): boolean {
  return (
    a.sourceSchemaVersion === b.sourceSchemaVersion &&
    a.profileId === b.profileId &&
    a.revision === b.revision &&
    a.checksum === b.checksum
  );
}

/** Metadata sidecar only: native index, transcript and model history remain owned by the reader. */
export class LegacyWorkspaceMigration {
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private constructor(
    private readonly owner: ProfileFileOwner,
    private readonly reader: LegacyPersistentSessionIndexReader,
    private readonly resolver: LegacyTargetResolver,
  ) {}
  static async open(
    sidecarPath: string,
    reader: LegacyPersistentSessionIndexReader,
    resolver: LegacyTargetResolver,
  ) {
    const owner = await ProfileFileOwner.open(sidecarPath);
    try {
      const existing = await owner.read();
      if (existing !== undefined) migrationSchema.parse(existing);
      return new LegacyWorkspaceMigration(owner, reader, resolver);
    } catch (error) {
      await owner.close();
      throw error;
    }
  }
  async close() {
    this.closing = true;
    await this.queue;
    await this.owner.close();
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("migration-closed"));
    const job = this.queue.then(operation);
    this.queue = job.catch(() => undefined);
    return job;
  }
  /** Public read-only references; the native owner remains the authority for every live fact. */
  async listMappings(): Promise<readonly LegacyMapping[]> {
    const raw = await this.owner.read();
    if (raw === undefined) return [];
    const persisted = migrationSchema.parse(raw);
    if (!(await this.reader.verifyBackup(persisted.source)))
      throw new Error("unverified-native-backup");
    return persisted.mappings;
  }
  async dryRun(): Promise<MigrationPreview> {
    const source = legacyExportSchema.parse(await this.reader.exportAll());
    const ids = source.records.map(({ workspaceKey, nativeSessionId }) =>
      JSON.stringify([workspaceKey, nativeSessionId]),
    );
    if (
      new Set(ids).size !== ids.length ||
      new Set(source.records.map(({ id }) => id)).size !== source.records.length
    )
      throw new Error("duplicate-legacy-id");
    const mapped: LegacyMapping[] = [];
    const pending: MigrationPreview["pending"] = [];
    for (const record of source.records) {
      if (!record.targetId || !record.nativeCwd || !record.harnessId || !record.modelBinding) {
        pending.push({ legacyId: record.id, reason: "missing-native-metadata" });
        continue;
      }
      try {
        const verified = await this.resolver.resolve(record);
        if (!verified) {
          pending.push({ legacyId: record.id, reason: "needs-verification" });
          continue;
        }
        const binding = repositoryBindingSchema.parse(verified.binding);
        const cwdRelativeToWorktree = cwdRelativeToWorktreeSchema.parse(
          verified.cwdRelativeToWorktree,
        );
        const workspace = worktreeWorkspaceSchema.parse(verified.workspace);
        if (
          binding.executionTargetId !== record.targetId ||
          workspace.repositoryBindingId !== binding.id ||
          workspace.projectId !== binding.projectId ||
          workspace.lifecycle !== "active"
        )
          throw new Error("target-mismatch");
        mapped.push(
          mappingSchema.parse({
            legacyId: record.id,
            nativeSessionId: record.nativeSessionId,
            sourceWorkspaceKey: record.workspaceKey,
            sourceWorkspacePath: record.workspacePath,
            projectId: binding.projectId,
            workspaceId: workspace.id,
            targetId: record.targetId,
            worktreeGeneration: workspace.worktreeGeneration,
            repositoryBindingId: binding.id,
            cwdRelativeToWorktree,
            modelBinding: record.modelBinding,
          }),
        );
      } catch (error) {
        pending.push({
          legacyId: record.id,
          reason: error instanceof Error ? error.message : "needs-verification",
        });
      }
    }
    return { mapped, pending, source };
  }
  apply(): Promise<MigrationPreview> {
    return this.serialize(() => this.applyInternal());
  }
  private async applyInternal(): Promise<MigrationPreview> {
    const preview = await this.dryRun();
    const raw = await this.owner.read();
    const existing = raw === undefined ? undefined : migrationSchema.parse(raw);
    if (existing && !sameSource(existing.source, preview.source))
      throw new Error("legacy-index-changed");
    const byId = new Map(
      existing?.mappings.map((row) => [
        JSON.stringify([row.sourceWorkspaceKey, row.nativeSessionId]),
        row,
      ]),
    );
    for (const row of preview.mapped) {
      const key = JSON.stringify([row.sourceWorkspaceKey, row.nativeSessionId]);
      const previous = byId.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error("migration-mapping-conflict");
      byId.set(key, row);
    }
    // 中文：备份必须由原生持久化 owner 验证，不能直接复制正在写入的 SQLite/WAL 主文件。
    const backup =
      existing?.source ?? legacyBackupSchema.parse(await this.reader.backup(preview.source));
    if (!sameSource(backup, preview.source) || !(await this.reader.verifyBackup(backup)))
      throw new Error("unverified-native-backup");
    const current = legacyExportSchema.parse(await this.reader.exportAll());
    if (
      !sameSource(backup, current) ||
      JSON.stringify(preview.source.records) !== JSON.stringify(current.records)
    )
      throw new Error("legacy-index-changed");
    await this.owner.write(
      migrationSchema.parse({ schemaVersion: 1, source: backup, mappings: [...byId.values()] }),
    );
    return preview;
  }
  rollback(): Promise<void> {
    return this.serialize(() => this.rollbackInternal());
  }
  private async rollbackInternal(): Promise<void> {
    const raw = await this.owner.read();
    if (!raw) return;
    const existing = migrationSchema.parse(raw);
    if (!(await this.reader.verifyBackup(existing.source)))
      throw new Error("unverified-native-backup");
    // No native mutation occurred; rollback removes only the sidecar.
    await this.owner.remove();
  }
}
