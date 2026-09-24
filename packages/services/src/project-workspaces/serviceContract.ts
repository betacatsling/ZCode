import type {
  Project,
  RepositoryBinding,
  SidebarSnapshot,
  UnadoptedWorktreeCandidate,
  WorktreeOperation,
  WorktreeWorkspace,
} from "@zcode/shared/project-workspaces";

/** The execution target, not the profile, verifies Git and worktree facts. */
export interface ProjectCatalogTargetPort {
  inspectRepository(input: {
    targetId: string;
    path: string;
  }): Promise<{ executionTargetId: string; gitCommonDir: string }>;
  discover(binding: RepositoryBinding): Promise<readonly UnadoptedWorktreeCandidate[]>;
  adopt(input: {
    binding: RepositoryBinding;
    workspaceId: string;
    title: string;
    sortOrder: number;
    worktreePath: string;
  }): Promise<WorktreeWorkspace>;
  create(input: {
    binding: RepositoryBinding;
    workspaceId: string;
    title: string;
    sortOrder: number;
    baseRef: string;
    branch: string;
    worktreePath: string;
  }): Promise<WorktreeWorkspace>;
  remove(input: {
    workspaceId: string;
    expectedGeneration: string;
    confirmation: true;
  }): Promise<WorktreeWorkspace>;
}

/** Profile catalog owns presentation; target host verifies Git facts before mutation/admission. */
export interface IProjectCatalogService {
  sidebarSnapshot(): Promise<SidebarSnapshot>;
  project(id: string): Promise<Project | undefined>;
  binding(id: string): Promise<RepositoryBinding | undefined>;
  importProject(input: {
    id: string;
    name: string;
    targetId: string;
    repositoryPath: string;
    bindingId: string;
  }): Promise<Project>;
  updateProject(
    id: string,
    update: {
      name?: string;
      iconAssetId?: string | null;
      pinned?: boolean;
      hidden?: boolean;
      archived?: boolean;
      defaultWorkspaceId?: string | null;
      sortOrder?: number;
    },
  ): Promise<Project>;
  updateWorkspace(
    id: string,
    update: { title?: string; hidden?: boolean; archived?: boolean; sortOrder?: number },
  ): Promise<WorktreeWorkspace>;
  /** Read-only discovery never adopts, starts agents or prunes Git metadata. */
  discover(bindingId: string): Promise<readonly UnadoptedWorktreeCandidate[]>;
  adopt(input: {
    bindingId: string;
    workspaceId: string;
    title: string;
    worktreePath: string;
  }): Promise<WorktreeWorkspace>;
  create(input: {
    bindingId: string;
    workspaceId: string;
    title: string;
    worktreePath: string;
    baseRef: string;
    branch: string;
  }): Promise<WorktreeWorkspace>;
  remove(input: {
    workspaceId: string;
    expectedGeneration: string;
    confirmation: true;
  }): Promise<WorktreeWorkspace>;
  /** Compatibility dispatch for existing callers; mutations use the same explicit target port. */
  apply(
    operation: WorktreeOperation,
  ): Promise<WorktreeWorkspace | readonly UnadoptedWorktreeCandidate[]>;
  readonly revision: number;
  onChange(listener: (revision: number) => void): () => void;
}
