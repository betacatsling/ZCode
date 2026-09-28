import type {
  IProjectCatalogService,
  ProjectCatalogFile,
  ProjectCatalogReadModel,
  ProjectCatalogTargetConnection,
  ProjectCatalogTargetSnapshot,
} from "./contract.js";

export const projectCatalogContractExample: ProjectCatalogFile = {
  schemaVersion: 2,
  projects: [
    {
      schemaVersion: 1,
      id: "project-example",
      name: "Example Project",
      defaultWorkspaceId: "workspace-local",
      defaultWorkspaceTargetId: "target-local",
      workspaceIds: [],
      repositoryReferences: [
        {
          projectId: "project-example",
          targetId: "target-local",
          repositoryBindingId: "binding-local",
          lastVerifiedAt: 1_800_000_000_000,
          targetFreshness: "live",
        },
        {
          projectId: "project-example",
          targetId: "target-remote",
          repositoryBindingId: "binding-remote",
          lastVerifiedAt: 1_799_999_000_000,
          targetFreshness: "offline",
        },
      ],
      workspaceReferences: [
        {
          projectId: "project-example",
          targetId: "target-local",
          workspaceId: "workspace-local",
          repositoryBindingId: "binding-local",
          verification: "verified",
          lastVerifiedAt: 1_800_000_000_000,
          targetFreshness: "live",
          presentation: {
            worktree: {
              title: "Local checkout",
              head: { kind: "branch", ref: "main", oid: "abc123" },
              isMainWorktree: true,
              lifecycle: "active",
            },
          },
        },
        {
          projectId: "project-example",
          targetId: "target-remote",
          workspaceId: "workspace-remote",
          repositoryBindingId: "binding-remote",
          verification: "verified",
          lastVerifiedAt: 1_799_999_000_000,
          targetFreshness: "offline",
          // Offline UI can show title/head/freshness; no path or execution grant is cached.
          presentation: {
            worktree: {
              title: "Remote checkout",
              head: { kind: "branch", ref: "feature", oid: "def456" },
              isMainWorktree: false,
              lifecycle: "active",
            },
          },
        },
      ],
      pinned: false,
      sortOrder: 0,
    },
  ],
  targets: [
    {
      targetId: "target-local",
      freshness: "live",
      lastVerifiedAt: 1_800_000_000_000,
      freshnessUpdatedAt: 1_800_000_000_000,
      presentation: { kind: "local" },
    },
    {
      targetId: "target-remote",
      freshness: "offline",
      lastVerifiedAt: 1_799_999_000_000,
      freshnessUpdatedAt: 1_800_000_000_100,
      presentation: { kind: "docker", displayName: "Docker · worker-box" },
    },
  ],
};

export const projectCatalogOfflineReadModelExample: ProjectCatalogReadModel = {
  ...projectCatalogContractExample,
  schemaVersion: 1,
};

/** Build from IWorktreeService availability/read; map fields and leave paths/generations out. */
export const projectCatalogTargetSnapshotExample: ProjectCatalogTargetSnapshot = {
  schemaVersion: 1,
  targetId: "target-local",
  observedAt: 1_800_000_000_000,
  targetPresentation: { kind: "local" },
  bindings: [
    {
      id: "binding-local",
      projectId: "project-example",
      executionTargetId: "target-local",
    },
  ],
  workspaces: [
    {
      id: "workspace-local",
      projectId: "project-example",
      repositoryBindingId: "binding-local",
      title: "Local checkout",
      isMainWorktree: true,
      head: { kind: "branch", ref: "main", oid: "abc123" },
      lifecycle: "active",
      verification: "verified",
    },
  ],
  // Omit a workspace entry when its Host summary read failed; omission preserves its cache.
  sessionSummaries: [],
};

/** Serialize read→ingest per target; the aggregate is display-only. */
export async function ingestAndReadProjectCatalog(
  catalog: IProjectCatalogService,
  snapshot: ProjectCatalogTargetSnapshot,
  targetConnections: readonly ProjectCatalogTargetConnection[],
) {
  await catalog.ingestTargetSnapshot(snapshot);
  return catalog.readWorkspaceCatalog(targetConnections);
}
