import { z } from "zod";
import { cwdRelativeToWorktreeSchema, modelBindingRequestSchema } from "@zcode/shared/agent-host";
import type { RepositoryBinding, WorktreeWorkspace } from "@zcode/shared/project-workspaces";

/** Native scope is immutable: workspaceKey is the SQLite primary-key scope, not the mapped worktree identity. */
export const legacyRecordSchema = z.strictObject({
  id: z.string().min(1),
  nativeSessionId: z.string().min(1),
  workspaceKey: z.string().min(1),
  targetId: z.string().min(1).optional(),
  workspaceIdentity: z.string().min(1).optional(),
  workspacePath: z.string().min(1),
  nativeCwd: z.string().min(1).optional(),
  nativeProvider: z.string().optional(),
  nativeModel: z.string().optional(),
  nativeThoughtLevel: z.string().optional(),
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
  .pick({ sourceSchemaVersion: true, profileId: true, revision: true, checksum: true })
  .extend({ backupId: z.string().min(1) });
export type LegacyBackup = z.infer<typeof legacyBackupSchema>;
export const mappingSchema = z.strictObject({
  legacyId: z.string().min(1),
  nativeSessionId: z.string().min(1),
  sourceWorkspaceKey: z.string().min(1),
  sourceWorkspacePath: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  targetId: z.string().min(1),
  worktreeGeneration: z.string().min(1),
  /** Older sidecars without binding provenance remain history-only. */
  repositoryBindingId: z.string().min(1).optional(),
  cwdRelativeToWorktree: cwdRelativeToWorktreeSchema,
  modelBinding: modelBindingRequestSchema,
});
export type LegacyMapping = z.infer<typeof mappingSchema>;
export interface LegacyPersistentSessionIndexReader {
  exportAll(): Promise<LegacyExport>;
  backup(exported: LegacyExport): Promise<LegacyBackup>;
  verifyBackup(backup: LegacyBackup): Promise<boolean>;
}
export interface LegacyTargetResolver {
  /** Target proves canonical native cwd lies inside the selected worktree; never trusts input relative cwd. */
  resolve(
    record: LegacyRecord,
  ): Promise<
    | { binding: RepositoryBinding; workspace: WorktreeWorkspace; cwdRelativeToWorktree: string }
    | undefined
  >;
}
export interface MigrationPreview {
  mapped: LegacyMapping[];
  pending: { legacyId: string; reason: string }[];
  source: LegacyExport;
}
