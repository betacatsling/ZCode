import type {
  Project,
  RepositoryBinding,
  SidebarSnapshot,
  WorktreeOperation,
  WorktreeWorkspace,
} from "@zcode/shared/project-workspaces";

/** Profile catalog owns presentation; target host verifies Git facts before mutation/admission. */
export interface IProjectCatalogService {
  sidebarSnapshot(): Promise<SidebarSnapshot>;
  project(id: string): Promise<Project | undefined>;
  /** Read-only discovery never adopts, starts agents or prunes Git metadata. */
  discover(bindingId: string): Promise<readonly WorktreeWorkspace[]>;
  /** Mutations require target-side preflight, generation fencing and explicit authorization. */
  apply(operation: WorktreeOperation): Promise<WorktreeWorkspace>;
  binding(id: string): Promise<RepositoryBinding | undefined>;
}
