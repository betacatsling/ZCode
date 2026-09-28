import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  SessionHierarchyFile,
  SessionHierarchyRecord,
  SessionMigrationSource,
} from "@zcode/shared/agent-host/session-hierarchy";

export type SessionOwnerKind = "native-v4" | "agent-host";

export interface LegacySessionLocator {
  sourceKey: string;
  nativeSessionId: string;
  ownerKind?: SessionOwnerKind;
  targetId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  cwd?: string;
  harnessId?: string;
  modelSelection?: ModelSelection;
  modelBindingKind?: "host-managed" | "harness-managed";
  /** Legacy model head retained for fingerprinting; provider identity is not inferred. */
  legacyModelId?: string;
  /** Target-owned root used only for worktree matching and cwd derivation. */
  resolvedWorktreePath?: string;
  resolvedRepositoryCommonDir?: string;
  /** Present only from a durable owner fact; legacy rows never inherit the current generation. */
  workspaceId?: string;
  worktreeGeneration?: string;
  ownerFactSource?: "owner-index" | "creation-receipt";
  title?: string;
  resolutionStatus?: "nonGit" | "missing";
}

export interface SessionIndexPort {
  listPersistedSessionLocators(): Promise<readonly LegacySessionLocator[]>;
}

export interface AdoptedWorktreeLocator {
  targetId: string;
  projectId: string;
  workspaceId: string;
  worktreePath: string;
  worktreeGeneration: string;
  workspaceIdentity?: string;
  lifecycle: "active" | "archived" | "missing" | "removed";
  verification: "verified" | "needsVerification";
}

export interface WorktreeReadPort {
  read(): Promise<{ workspaces: readonly AdoptedWorktreeLocator[] }>;
  discover?(inputPath: string): Promise<WorktreeDiscoveryPortResult>;
}

export interface WorktreeDiscoveryPortResult {
  kind: "nonGit" | "git" | "bare";
  reason?: "not-git" | "missing-path";
  candidates: readonly { worktreePath: string; repositoryCommonDir?: string }[];
}

export interface ExternalSessionIndexPort {
  listPersistedExternalSessionLocators(
    workspaces: readonly AdoptedWorktreeLocator[],
  ): Promise<readonly LegacySessionLocator[]>;
}

export interface CurrentOwnerSessionIndexPort {
  listCurrentOwnerSessionLocators(
    workspaces: readonly AdoptedWorktreeLocator[],
  ): Promise<readonly LegacySessionLocator[]>;
}

export interface SessionHierarchyPersistence {
  read(): Promise<unknown | null>;
  update(
    mutator: (current: unknown | null) => SessionHierarchyFile | Promise<SessionHierarchyFile>,
  ): Promise<SessionHierarchyFile>;
  rollback(expectedCurrentRevision: string): Promise<SessionHierarchyFile | null>;
}

export interface SessionHierarchyApplyRequest {
  source: SessionMigrationSource;
  expectedCurrentRevision: string | null;
}

export interface ISessionHierarchyService {
  read(): Promise<SessionHierarchyFile | null>;
  preview(): Promise<SessionHierarchyFile>;
  apply(request: SessionHierarchyApplyRequest): Promise<SessionHierarchyFile>;
  rollback(expectedCurrentRevision: string): Promise<SessionHierarchyFile | null>;
}

export type { SessionHierarchyFile, SessionHierarchyRecord };
