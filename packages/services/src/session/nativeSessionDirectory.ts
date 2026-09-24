import { createHash } from "node:crypto";
import type { SessionSummary, WorktreeWorkspace } from "@zcode/shared/project-workspaces";
import type { NativeSessionCatalogPort, NativeSessionNavigation } from "./nativeComposition.js";
import type { LegacyMapping } from "../project-workspaces/migrationContract.js";
import type { NativeIndexFact } from "./nativePersistentSessionIndex.js";

export interface NativeSessionDirectorySource {
  onChange?(listener: () => void): () => void;
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

  private async joined(): Promise<Array<{ mapping: LegacyMapping; fact: NativeIndexFact }>> {
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
    return mappings.flatMap((mapping) => {
      const fact = byScope.get(
        JSON.stringify([mapping.sourceWorkspaceKey, mapping.nativeSessionId]),
      );
      return fact && !fact.deleted ? [{ mapping, fact }] : [];
    });
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
    const { mapping } = found;
    const owner: NativeSessionOwnerRef = {
      targetId: mapping.targetId,
      projectId: mapping.projectId,
      workspaceId: mapping.workspaceId,
      worktreeGeneration: mapping.worktreeGeneration,
      sourceWorkspaceKey: mapping.sourceWorkspaceKey,
      sourceWorkspacePath: mapping.sourceWorkspacePath,
      nativeSessionId: mapping.nativeSessionId,
      cwdRelativeToWorktree: mapping.cwdRelativeToWorktree,
    };
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
