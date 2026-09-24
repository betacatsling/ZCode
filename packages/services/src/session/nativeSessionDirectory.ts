import type { SessionSummary, WorktreeWorkspace } from "@zcode/shared/project-workspaces";
import type { LegacyMapping } from "../project-workspaces/migrationContract.js";
import type { CatalogSessionIndex } from "../project-workspaces/sidebarIndexService.js";
import type { NativeIndexFact } from "./nativePersistentSessionIndex.js";

export interface NativeSessionDirectorySource {
  listMappings(): Promise<readonly LegacyMapping[]>;
  readFacts(): Promise<readonly NativeIndexFact[]>;
}
export interface NativeSessionOwnerRef {
  targetId: string;
  projectId: string;
  workspaceId: string;
  worktreeGeneration: string;
  sourceWorkspaceKey: string;
  sourceWorkspacePath: string;
  nativeSessionId: string;
  cwdRelativeToWorktree: string;
}

/** Async owner lookup for Host/UI; target+workspace+native scope cannot be inferred from an unscoped task id. */
export class NativeSessionDirectory implements CatalogSessionIndex {
  constructor(private readonly source: NativeSessionDirectorySource) {}

  private async joined(): Promise<Array<{ mapping: LegacyMapping; fact: NativeIndexFact }>> {
    const [mappings, facts] = await Promise.all([
      this.source.listMappings(),
      this.source.readFacts(),
    ]);
    const byScope = new Map(
      facts.map((fact) => [JSON.stringify([fact.workspaceKey, fact.nativeSessionId]), fact]),
    );
    return mappings.flatMap((mapping) => {
      const fact = byScope.get(
        JSON.stringify([mapping.sourceWorkspaceKey, mapping.nativeSessionId]),
      );
      return fact && !fact.deleted ? [{ mapping, fact }] : [];
    });
  }

  async resolve(input: {
    targetId: string;
    workspaceId: string;
    sourceWorkspaceKey: string;
    nativeSessionId: string;
  }): Promise<NativeSessionOwnerRef | undefined> {
    const found = (await this.joined()).find(
      ({ mapping }) =>
        mapping.targetId === input.targetId &&
        mapping.workspaceId === input.workspaceId &&
        mapping.sourceWorkspaceKey === input.sourceWorkspaceKey &&
        mapping.nativeSessionId === input.nativeSessionId,
    );
    if (!found) return undefined;
    const { mapping } = found;
    return {
      targetId: mapping.targetId,
      projectId: mapping.projectId,
      workspaceId: mapping.workspaceId,
      worktreeGeneration: mapping.worktreeGeneration,
      sourceWorkspaceKey: mapping.sourceWorkspaceKey,
      sourceWorkspacePath: mapping.sourceWorkspacePath,
      nativeSessionId: mapping.nativeSessionId,
      cwdRelativeToWorktree: mapping.cwdRelativeToWorktree,
    };
  }

  async allSessions(): Promise<readonly SessionSummary[]> {
    return (await this.joined()).map(({ mapping, fact }) => ({
      session: {
        schemaVersion: 1,
        id: mapping.legacyId,
        projectId: mapping.projectId,
        workspaceId: mapping.workspaceId,
        harnessId: "zcode",
        title: fact.title || mapping.nativeSessionId,
        sortOrder: 0,
        archived: fact.archived,
      },
      updatedAt: fact.updatedAt,
      activity: fact.waiting ? ("waiting" as const) : ("unknown" as const),
      freshness: "unknown" as const,
      ...(fact.status === "completed" ? { lastTurn: "succeeded" as const } : {}),
      ...(fact.status === "error" ? { lastTurn: "failed" as const } : {}),
      unread: fact.unread,
    }));
  }
  async workspaceFreshness(_workspace: WorktreeWorkspace): Promise<"unknown"> {
    // SQLite is persistent history, not a host heartbeat; activity cannot be inferred from stale running status.
    return "unknown";
  }
}
