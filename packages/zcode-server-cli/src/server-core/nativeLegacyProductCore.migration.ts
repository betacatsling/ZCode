import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { IWorkspaceHierarchyService, type ServiceCollection } from "@zcode/services";
import type { RepositoryBinding, WorktreeWorkspace } from "@zcode/shared/project-workspaces";
import {
  LegacyWorkspaceMigration,
  NativePersistentSessionIndex,
  type LegacyTargetResolver,
  type NativeSessionMetadataReader,
} from "@zcode/services/node";

/** Only the public migration writer may certify a mapping from actual CLI task-index evidence. */
export async function migrateOriginalLegacySession(input: {
  services: ServiceCollection;
  configRoot: string;
  dbPath: string;
  targetId: string;
  workspaceId: string;
  sessionId: string;
  workspace: WorktreeWorkspace;
  binding: RepositoryBinding;
}): Promise<{ indexedOriginalId: string; mappingCount: number }> {
  const { configRoot, dbPath, targetId, workspaceId, sessionId, workspace, binding } = input;
  const hierarchy = input.services.get(IWorkspaceHierarchyService);
  const metadata: NativeSessionMetadataReader = {
    async read(record) {
      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = database
          .prepare("SELECT directory, workspace_id FROM session WHERE id = ?")
          .get(record.nativeSessionId) as
          | { directory: string; workspace_id: string | null }
          | undefined;
        if (
          !row ||
          !isAbsolute(row.directory) ||
          row.directory !== record.workspacePath ||
          row.workspace_id !== record.workspaceKey ||
          record.workspacePath !== workspace.worktreePath ||
          record.workspaceKey !== workspace.workspaceIdentity
        )
          return undefined;
        return {
          cwd: row.directory,
          targetId: binding.executionTargetId,
          scopeVerified: row.workspace_id === record.workspaceKey,
        };
      } finally {
        database.close();
      }
    },
  };
  const index = new NativePersistentSessionIndex(
    join(configRoot, "tasks-index.sqlite"),
    join(configRoot, "native-migration", "backups"),
    targetId,
    metadata,
  );
  const exported = await index.exportAll();
  const legacy = exported.records.find((record) => record.nativeSessionId === sessionId);
  assert.ok(legacy, "migration must consume the actual native task-index row");
  assert.equal(legacy.workspaceKey, workspace.workspaceIdentity);
  assert.equal(legacy.workspacePath, workspace.worktreePath);
  assert.ok(legacy.modelBinding, "the old index must carry an unambiguous model binding");
  const resolver: LegacyTargetResolver = {
    async resolve(record) {
      if (
        record.nativeSessionId !== sessionId ||
        record.targetId !== binding.executionTargetId ||
        record.workspaceKey !== workspace.workspaceIdentity ||
        record.workspacePath !== workspace.worktreePath ||
        !record.nativeCwd ||
        !record.modelBinding
      )
        return undefined;
      const preview = await hierarchy.previewRemoval({
        workspaceId,
        expectedGeneration: workspace.worktreeGeneration,
      });
      if (preview.unknown || !preview.git || preview.generation !== workspace.worktreeGeneration)
        return undefined;
      const worktreePath = await realpath(workspace.worktreePath);
      const nativeCwd = await realpath(record.nativeCwd);
      const cwdRelativeToWorktree = relative(worktreePath, nativeCwd);
      if (
        cwdRelativeToWorktree === ".." ||
        cwdRelativeToWorktree.startsWith(`..${sep}`) ||
        isAbsolute(cwdRelativeToWorktree)
      )
        return undefined;
      return {
        binding,
        workspace,
        cwdRelativeToWorktree: cwdRelativeToWorktree || ".",
      };
    },
  };
  const mappingPath = join(configRoot, "native-migration", "mapping.json");
  const migration = await LegacyWorkspaceMigration.open(mappingPath, index, resolver);
  try {
    const preview = await migration.apply();
    assert.equal(preview.mapped.length, 1);
    const mappingCount = (await migration.listMappings()).length;
    assert.equal(mappingCount, 1);
    const persistedMigration = JSON.parse(await readFile(mappingPath, "utf8")) as {
      source: Parameters<NativePersistentSessionIndex["verifyBackup"]>[0];
      mappings: unknown[];
    };
    assert.equal(persistedMigration.source.profileId, exported.profileId);
    assert.equal(persistedMigration.source.checksum, exported.checksum);
    assert.equal(persistedMigration.mappings.length, 1);
    assert.equal(await index.verifyBackup(persistedMigration.source), true);
    return { indexedOriginalId: legacy.nativeSessionId, mappingCount };
  } finally {
    await migration.close();
  }
}
