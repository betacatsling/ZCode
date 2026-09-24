import type { Event } from "@zcode/rpc";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { createServiceDescriptor } from "../descriptors.js";
import type { RemovalPreview } from "./worktreeService.js";
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
  /** Verifies common-directory instance evidence, not a coincidentally reused path. */
  sameRepository(binding: RepositoryBinding, path: string): Promise<boolean>;
  registerBinding(binding: RepositoryBinding, path: string): Promise<void>;
  setArchivePolicy(kind: "binding" | "workspace", id: string, archived: boolean): Promise<void>;
  previewRemoval(workspaceId: string, generation: string): Promise<RemovalPreview>;
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
    /** Catalog-owned metadata sent by value; target verifies binding/generation/path. */
    workspace: WorktreeWorkspace;
  }): Promise<WorktreeWorkspace>;
}

/** Profile catalog owns presentation; target host verifies Git facts before mutation/admission. */
export interface IProjectCatalogService {
  sidebarSnapshot(): Promise<SidebarSnapshot>;
  project(id: string): Promise<Project | undefined>;
  binding(id: string): Promise<RepositoryBinding | undefined>;
  workspace(id: string): Promise<WorktreeWorkspace | undefined>;
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
  previewRemoval(workspaceId: string, expectedGeneration: string): Promise<RemovalPreview>;
  /** Compatibility dispatch for existing callers; mutations use the same explicit target port. */
  apply(
    operation: WorktreeOperation,
  ): Promise<WorktreeWorkspace | readonly UnadoptedWorktreeCandidate[]>;
  /** RPC-friendly async read and Event; sync revision/onChange remain local conveniences only. */
  getRevision(): Promise<number>;
  readonly onDidChange: Event<number>;
  readonly revision: number;
  onChange(listener: (revision: number) => void): () => void;
}

/** Descriptor-ready RPC surface; no callback or local revision getter crosses the wire. */
export type ProjectCatalogRpcService = Omit<IProjectCatalogService, "revision" | "onChange">;
export const IProjectCatalogRpcService =
  createServiceDescriptor<ProjectCatalogRpcService>("projectCatalog");
/** Target methods carry plain DTOs; Host callbacks remain local. Channel registration is a later composition step. */
export const IProjectCatalogTargetRpcService =
  createServiceDescriptor<ProjectCatalogTargetPort>("projectCatalogTarget");

/** Host-local callback is never serialized through the catalog/target RPC channel. */
export interface WorkspaceAdmissionPort {
  verify(spec: SessionSpecV2): Promise<{ canonicalCwd: string }>;
  withAdmission<T>(spec: SessionSpecV2, action: (canonicalCwd: string) => Promise<T>): Promise<T>;
}
