import { createHash } from "node:crypto";
import type { SessionSummary, WorktreeWorkspace } from "@zcode/shared/project-workspaces";
import type { NativeSessionCatalogPort, NativeSessionNavigation } from "./nativeComposition.js";
import type { LegacyMapping } from "../project-workspaces/migrationContract.js";
import type { NativeIndexFact } from "./nativePersistentSessionIndex.js";
import type { NativeSessionMetadataReader } from "./nativeSessionMetadata.js";

export type NativeCreatedMapping = Omit<LegacyMapping, "legacyId"> & {
  commandId: string;
  nativeDatabasePath: string;
  databaseId: string;
};
type DirectoryMapping = LegacyMapping | NativeCreatedMapping;

export interface NativeSessionDirectorySource {
  onChange?(listener: () => void): () => void;
  listMappings(): Promise<readonly LegacyMapping[]>;
  /** Separate certified new-create source; never masquerades as backup-verified legacy migration. */
  listNewMappings?(): Promise<readonly NativeCreatedMapping[]>;
  readFacts(): Promise<readonly NativeIndexFact[]>;
  verifySource?(): Promise<void>;
  /** Production joins require a current native-store scope attestation; no path containment inference. */
  metadata?: NativeSessionMetadataReader;
}
export interface NativeSessionOwnerRef {
  targetId: string;
  projectId: string;
  workspaceId: string;
  worktreeGeneration: string;
  repositoryBindingId?: string;
  sourceWorkspaceKey: string;
  sourceWorkspacePath: string;
  nativeSessionId: string;
  cwdRelativeToWorktree: string;
}

/** Async owner lookup for Host/UI; target+workspace+native scope cannot be inferred from an unscoped task id. */
export function nativeTreeSessionId(
  owner: Pick<NativeSessionOwnerRef, "targetId" | "sourceWorkspaceKey" | "nativeSessionId">,
): string {
  return `native:${createHash("sha256")
    .update(JSON.stringify([owner.targetId, owner.sourceWorkspaceKey, owner.nativeSessionId]))
    .digest("hex")}`;
}

export class NativeSessionDirectory implements NativeSessionCatalogPort {
  constructor(private readonly source: NativeSessionDirectorySource) {}

  onChange(listener: () => void): () => void {
    return this.source.onChange?.(listener) ?? (() => {});
  }

  private async joined(): Promise<Array<{ mapping: DirectoryMapping; fact: NativeIndexFact }>> {
    await this.source.verifySource?.();
    const [mappings, facts] = await Promise.all([
      this.source.listMappings(),
      this.source.readFacts(),
    ]);
    const byScope = new Map<string, NativeIndexFact>();
    for (const fact of facts) {
      const key = JSON.stringify([fact.workspaceKey, fact.nativeSessionId]);
      if (byScope.has(key)) throw new Error("duplicate-native-scope");
      byScope.set(key, fact);
    }
    const verified = await Promise.all(
      mappings.map(async (mapping) => {
        const fact = byScope.get(
          JSON.stringify([mapping.sourceWorkspaceKey, mapping.nativeSessionId]),
        );
        if (
          !fact ||
          fact.deleted ||
          (fact.sourceWorkspacePath
            ? fact.sourceWorkspacePath !== mapping.sourceWorkspacePath
            : !!this.source.metadata)
        )
          return undefined;
        if (this.source.metadata) {
          const native = await this.source.metadata.read({
            workspaceKey: mapping.sourceWorkspaceKey,
            workspacePath: mapping.sourceWorkspacePath,
            nativeSessionId: mapping.nativeSessionId,
          });
          // 中文：缺 workspaceID 的旧记录可供迁移预览，不能凭相等/包含的 cwd 冒充在线 owner。
          if (!native?.scopeVerified || native.targetId !== mapping.targetId) return undefined;
        }
        return { mapping, fact };
      }),
    );
    const legacy = verified.filter(
      (row): row is { mapping: LegacyMapping; fact: NativeIndexFact } => !!row,
    );
    const fresh = (await this.source.listNewMappings?.()) ?? [];
    // 中文：创建时 CLI 已有 session row，task-index 可能随后投影同一 ID；它不是第二个旧任务。
    // 新映射来源已由每个源 DB 的完成收据认证，不要求不相关的 legacy backup 证明。
    for (const mapping of fresh) {
      if (
        legacy.some(
          (row) =>
            row.mapping.nativeSessionId === mapping.nativeSessionId &&
            row.mapping.sourceWorkspaceKey === mapping.sourceWorkspaceKey,
        )
      )
        throw new Error("duplicate-native-mapping-producer");
    }
    return [
      ...legacy,
      ...fresh.map((mapping) => ({
        mapping,
        fact: byScope.get(
          JSON.stringify([mapping.sourceWorkspaceKey, mapping.nativeSessionId]),
        ) ?? {
          workspaceKey: mapping.sourceWorkspaceKey,
          sourceWorkspacePath: mapping.sourceWorkspacePath,
          nativeSessionId: mapping.nativeSessionId,
          title: mapping.nativeSessionId,
          updatedAt: 0,
          status: null,
          archived: false,
          deleted: false,
          unread: false,
          nativeModel: null,
        },
      })),
    ];
  }

  private ownerFromMapping(mapping: DirectoryMapping): NativeSessionOwnerRef {
    return {
      targetId: mapping.targetId,
      projectId: mapping.projectId,
      workspaceId: mapping.workspaceId,
      worktreeGeneration: mapping.worktreeGeneration,
      repositoryBindingId: mapping.repositoryBindingId,
      sourceWorkspaceKey: mapping.sourceWorkspaceKey,
      sourceWorkspacePath: mapping.sourceWorkspacePath,
      nativeSessionId: mapping.nativeSessionId,
      cwdRelativeToWorktree: mapping.cwdRelativeToWorktree,
    };
  }

  /** Unscoped V4 ID is only usable after narrowing to the exact target and mapped workspace. */
  async resolveOriginalOwner(input: {
    targetId: string;
    workspaceId: string;
    nativeSessionId: string;
  }): Promise<NativeSessionNavigation | undefined> {
    const matches = (await this.joined()).filter(
      ({ mapping }) =>
        mapping.targetId === input.targetId &&
        mapping.workspaceId === input.workspaceId &&
        mapping.nativeSessionId === input.nativeSessionId,
    );
    if (matches.length > 1) throw new Error("ambiguous-native-owner");
    const mapping = matches[0]?.mapping;
    if (!mapping) return undefined;
    return {
      transport: "native-v4",
      treeSessionId: nativeTreeSessionId(mapping),
      owner: this.ownerFromMapping(mapping),
    };
  }

  async resolveOwner(
    input:
      | {
          targetId: string;
          workspaceId: string;
          sourceWorkspaceKey: string;
          nativeSessionId: string;
        }
      | { treeSessionId: string },
  ): Promise<NativeSessionNavigation | undefined> {
    const matches = (await this.joined()).filter(({ mapping }) =>
      "treeSessionId" in input
        ? nativeTreeSessionId({
            targetId: mapping.targetId,
            sourceWorkspaceKey: mapping.sourceWorkspaceKey,
            nativeSessionId: mapping.nativeSessionId,
          }) === input.treeSessionId
        : mapping.targetId === input.targetId &&
          mapping.workspaceId === input.workspaceId &&
          mapping.sourceWorkspaceKey === input.sourceWorkspaceKey &&
          mapping.nativeSessionId === input.nativeSessionId,
    );
    if (matches.length > 1) throw new Error("ambiguous-native-owner");
    const found = matches[0];
    if (!found) return undefined;
    const owner = this.ownerFromMapping(found.mapping);
    return { transport: "native-v4", treeSessionId: nativeTreeSessionId(owner), owner };
  }

  async allSessions(): Promise<readonly SessionSummary[]> {
    const joined = await this.joined();
    const ids = new Set<string>();
    for (const { mapping } of joined) {
      const id = nativeTreeSessionId({
        targetId: mapping.targetId,
        sourceWorkspaceKey: mapping.sourceWorkspaceKey,
        nativeSessionId: mapping.nativeSessionId,
      });
      if (ids.has(id)) throw new Error("duplicate-native-tree-id");
      ids.add(id);
    }
    return joined.map(({ mapping, fact }) => ({
      session: {
        schemaVersion: 1,
        id: nativeTreeSessionId({
          targetId: mapping.targetId,
          sourceWorkspaceKey: mapping.sourceWorkspaceKey,
          nativeSessionId: mapping.nativeSessionId,
        }),
        projectId: mapping.projectId,
        workspaceId: mapping.workspaceId,
        harnessId: "zcode",
        title: fact.title || mapping.nativeSessionId,
        sortOrder: 0,
        archived: fact.archived,
      },
      updatedAt: fact.updatedAt,
      activity: "unknown" as const,
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
