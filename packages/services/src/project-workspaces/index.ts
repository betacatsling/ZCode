import { randomUUID } from "node:crypto";
import type { CatalogSnapshot } from "./snapshot.js";
import { createLegacyWorkspaceMigration } from "./legacyWorkspaceMigration.js";
import { createProjectCatalog } from "./projectCatalog.js";
import type { CatalogStore, ProjectWorkspaceDeps } from "./ports.js";
import { buildSidebarIndex, type SessionActivityInput } from "./sidebarIndexService.js";
import { createMemoryCatalogStore } from "./store.js";
import { createWorktreeReconciler } from "./worktreeReconciler.js";
import { createWorktreeService } from "./worktreeService.js";

export { ProjectWorkspaceError } from "./errors.js";
export { sameWorkspaceIdentity, workspaceIdentityKey } from "./identity.js";
export { parsePorcelainZ } from "./porcelain.js";
export { resolveRepositoryBinding } from "./repositoryBindingResolver.js";
export { createFileCatalogStore, createMemoryCatalogStore } from "./store.js";
export { createProjectCatalog } from "./projectCatalog.js";
export { createWorktreeService, describeSharedWorkspace } from "./worktreeService.js";
export { createWorktreeReconciler } from "./worktreeReconciler.js";
export { buildSidebarIndex } from "./sidebarIndexService.js";
export { createLegacyWorkspaceMigration, planLegacyMigration } from "./legacyWorkspaceMigration.js";
export type {
  Project,
  RepositoryBinding,
  WorktreeWorkspace,
  AgentSessionRecord,
} from "./planTypes.js";
export type { CatalogSnapshot, MigrationMapping } from "./snapshot.js";
export type { DiscoveryReport, DiscoveredWorktree } from "./discovery.js";
export type { ExecutionLocation, CreateAgentSessionInput } from "./sessions.js";
export type {
  SidebarIndex,
  SidebarIndexInput,
  SessionActivityInput,
} from "./sidebarIndexService.js";
export type { LegacySessionInput, MigrationPlan } from "./legacyWorkspaceMigration.js";

function freshnessForSession(snapshot: CatalogSnapshot, sessionId: string) {
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const workspace = snapshot.workspaces.find((item) => item.id === session?.workspaceId);
  const binding = snapshot.bindings.find((item) => item.id === workspace?.repositoryBindingId);
  if (!binding) return undefined;
  return snapshot.freshnessByTargetId[binding.executionTargetId];
}

function storedActivities(snapshot: CatalogSnapshot): SessionActivityInput[] {
  return Object.entries(snapshot.sessionActivityById ?? {}).map(([sessionId, summary]) => ({
    sessionId,
    ...summary,
  }));
}

function retainExpiredActivity(
  snapshot: CatalogSnapshot,
  activity: SessionActivityInput,
  stored: SessionActivityInput | undefined,
): SessionActivityInput {
  const freshness = freshnessForSession(snapshot, activity.sessionId);
  if (freshness !== "offline" && freshness !== "stale") return activity;
  // 过期摘要只改连接新鲜度，保留原来的活动和轮次结果。
  const base = stored ?? activity;
  return { ...base, sessionId: activity.sessionId, connection: freshness };
}

function projectSessionActivities(
  snapshot: CatalogSnapshot,
  caller: readonly SessionActivityInput[] | undefined,
): SessionActivityInput[] {
  const stored = storedActivities(snapshot);
  const storedById = new Map(stored.map((item) => [item.sessionId, item]));
  const source = caller ?? stored;
  const seen = new Set<string>();
  const projected: SessionActivityInput[] = [];
  for (const activity of source) {
    seen.add(activity.sessionId);
    projected.push(retainExpiredActivity(snapshot, activity, storedById.get(activity.sessionId)));
  }
  for (const activity of stored) {
    if (seen.has(activity.sessionId)) continue;
    const freshness = freshnessForSession(snapshot, activity.sessionId);
    if (freshness === "offline" || freshness === "stale") {
      projected.push(retainExpiredActivity(snapshot, activity, activity));
    }
  }
  return projected;
}

export function createProjectWorkspaces(
  input: Omit<ProjectWorkspaceDeps, "store" | "idFactory"> & {
    store?: CatalogStore;
    idFactory?: () => string;
    knownHarnessIds?: readonly string[];
  },
) {
  const store = input.store ?? createMemoryCatalogStore();
  const idFactory = input.idFactory ?? randomUUID;
  const deps: ProjectWorkspaceDeps = { ...input, store, idFactory };
  const catalog = createProjectCatalog({ store, idFactory });
  const worktrees = createWorktreeService(deps);
  const reconciler = createWorktreeReconciler(deps);
  const migration = createLegacyWorkspaceMigration({
    store,
    knownHarnessIds: input.knownHarnessIds ?? [],
  });
  return {
    store,
    catalog,
    worktrees,
    reconciler,
    migration,
    async sidebar(options?: {
      query?: string;
      discoveredNotAdopted?: number | null;
      activities?: readonly SessionActivityInput[];
      collapsedWorkspaceIds?: readonly string[];
    }) {
      const snapshot: CatalogSnapshot = await store.read();
      const storedCounts = Object.values(snapshot.unadoptedCountByBindingId);
      const discovered =
        options && "discoveredNotAdopted" in options
          ? (options.discoveredNotAdopted ?? null)
          : storedCounts.length === 0
            ? null
            : storedCounts.reduce((sum, count) => sum + count, 0);
      return buildSidebarIndex({
        projects: snapshot.projects,
        bindings: snapshot.bindings,
        workspaces: snapshot.workspaces,
        sessions: snapshot.sessions,
        hiddenWorkspaceIds: snapshot.hiddenWorkspaceIds,
        archivedSessionIds: snapshot.archivedSessionIds,
        removedProjectIds: snapshot.removedProjectIds,
        freshnessByTargetId: snapshot.freshnessByTargetId,
        activities: projectSessionActivities(snapshot, options?.activities),
        discoveredNotAdopted: discovered,
        query: options?.query,
        collapsedWorkspaceIds: options?.collapsedWorkspaceIds,
      });
    },
  };
}
