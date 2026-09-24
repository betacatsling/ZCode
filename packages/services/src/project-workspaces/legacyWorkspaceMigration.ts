import { z } from "zod";
import { cwdRelativeToWorktreeSchema, modelBindingRequestSchema } from "@zcode/shared/agent-host";
import {
  repositoryBindingSchema,
  worktreeWorkspaceSchema,
  type RepositoryBinding,
  type WorktreeWorkspace,
} from "@zcode/shared/project-workspaces";
import { ProfileFileOwner } from "./profilePersistence.js";

/** Adapter exports ALL persistent task-index rows, not current tabs or paginated sidebar queries.
 * Required native fields: workspace_key (identity isolation), workspace_path, task_id,
 * meta_json/model selection and exact native cwd (or explicit unknown). Adapter derives a
 * stable execution target from trusted storage; missing remote target/model/cwd stays pending.
 * SQLite backup must use its own consistency mechanism (not copying a live WAL main file).
 */
export const legacyRecordSchema = z.strictObject({
  id: z.string().min(1),
  nativeSessionId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  workspaceIdentity: z.string().min(1).optional(),
  workspacePath: z.string().min(1),
  cwdRelativeToWorktree: cwdRelativeToWorktreeSchema.optional(),
  harnessId: z.string().min(1).optional(),
  modelBinding: modelBindingRequestSchema.optional(),
});
export type LegacyRecord = z.infer<typeof legacyRecordSchema>;
export const legacyExportSchema = z.strictObject({
  sourceSchemaVersion: z.number().int().positive(),
  profileId: z.string().min(1),
  revision: z.string().min(1),
  checksum: z.string().min(1),
  records: z.array(legacyRecordSchema),
});
export type LegacyExport = z.infer<typeof legacyExportSchema>;
export const legacyBackupSchema = legacyExportSchema
  .pick({
    sourceSchemaVersion: true,
    profileId: true,
    revision: true,
    checksum: true,
  })
  .extend({ backupId: z.string().min(1) });
export type LegacyBackup = z.infer<typeof legacyBackupSchema>;
export interface LegacyPersistentSessionIndexReader {
  /** Consistent native-owner export of complete persisted index, including closed tabs. */
  exportAll(): Promise<LegacyExport>;
  /** Durable verified backup of the SAME consistent export before publishing any mapping. */
  backup(exported: LegacyExport): Promise<LegacyBackup>;
  /** Check recoverability before rollback. Does not edit native sessions. */
  verifyBackup(backup: LegacyBackup): Promise<boolean>;
}
const mappingSchema = z.strictObject({
  legacyId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  worktreeGeneration: z.string().min(1),
  cwdRelativeToWorktree: cwdRelativeToWorktreeSchema,
  modelBinding: modelBindingRequestSchema,
});
const migrationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: legacyBackupSchema,
  mappings: z.array(mappingSchema),
});
export type LegacyMapping = z.infer<typeof mappingSchema>;
export interface LegacyTargetResolver {
  /** No local filesystem fallback; failure becomes a pending record. */
  resolve(record: LegacyRecord): Promise<
    | {
        binding: RepositoryBinding;
        workspace: WorktreeWorkspace;
      }
    | undefined
  >;
}
export interface MigrationPreview {
  mapped: LegacyMapping[];
  pending: { legacyId: string; reason: string }[];
  source: LegacyExport;
}
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
    await this.owner.close();
  }
  async dryRun(): Promise<MigrationPreview> {
    const source = legacyExportSchema.parse(await this.reader.exportAll());
    const ids = source.records.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate-legacy-id");
    const mapped: LegacyMapping[] = [];
    const pending: MigrationPreview["pending"] = [];
    for (const record of source.records) {
      if (
        !record.targetId ||
        !record.cwdRelativeToWorktree ||
        !record.harnessId ||
        !record.modelBinding
      ) {
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
        const workspace = worktreeWorkspaceSchema.parse(verified.workspace);
        if (
          binding.executionTargetId !== record.targetId ||
          workspace.repositoryBindingId !== binding.id ||
          workspace.projectId !== binding.projectId ||
          workspace.workspaceIdentity !==
            (record.workspaceIdentity?.trim() || record.workspacePath) ||
          workspace.lifecycle !== "active"
        )
          throw new Error("target-mismatch");
        mapped.push(
          mappingSchema.parse({
            legacyId: record.id,
            nativeSessionId: record.nativeSessionId,
            projectId: binding.projectId,
            workspaceId: workspace.id,
            targetId: record.targetId,
            worktreeGeneration: workspace.worktreeGeneration,
            cwdRelativeToWorktree: record.cwdRelativeToWorktree,
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
  async apply(): Promise<MigrationPreview> {
    const preview = await this.dryRun();
    const raw = await this.owner.read();
    const existing = raw === undefined ? undefined : migrationSchema.parse(raw);
    if (existing && !sameSource(existing.source, preview.source))
      throw new Error("legacy-index-changed");
    const byId = new Map(existing?.mappings.map((row) => [row.legacyId, row]));
    for (const row of preview.mapped) {
      const previous = byId.get(row.legacyId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error("migration-mapping-conflict");
      byId.set(row.legacyId, row);
    }
    // 中文：备份必须由原生持久化 owner 验证，不能直接复制正在写入的 SQLite/WAL 主文件。
    const backup =
      existing?.source ?? legacyBackupSchema.parse(await this.reader.backup(preview.source));
    if (!sameSource(backup, preview.source) || !(await this.reader.verifyBackup(backup)))
      throw new Error("unverified-native-backup");
    const current = legacyExportSchema.parse(await this.reader.exportAll());
    if (!sameSource(backup, current)) throw new Error("legacy-index-changed");
    await this.owner.write(
      migrationSchema.parse({ schemaVersion: 1, source: backup, mappings: [...byId.values()] }),
    );
    return preview;
  }
  async rollback(): Promise<void> {
    const raw = await this.owner.read();
    if (!raw) return;
    const existing = migrationSchema.parse(raw);
    if (!(await this.reader.verifyBackup(existing.source)))
      throw new Error("unverified-native-backup");
    // No native mutation occurred; rollback removes only the sidecar.
    await this.owner.remove();
  }
}
