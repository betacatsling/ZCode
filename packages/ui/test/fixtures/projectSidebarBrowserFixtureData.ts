import type {
  AgentHostSessionSummary,
  HarnessDirectorySnapshot,
  SessionHierarchyFile,
} from "@zcode/shared/agent-host";
import type {
  CreateWorkspaceRequest,
  FilesystemEvidence,
  RepositoryBindingRecord,
  WorktreeCandidate,
  WorktreeCatalogFile,
  WorktreeWorkspaceRecord,
} from "@zcode/services/worktree";
import type { ProjectCatalogFile } from "@zcode/services/project-catalog";
import type { ZCodeTaskMeta } from "@zcode/shared";

export const TARGET_ID = "fixture-target";
export const REPOSITORY_COMMON_DIR = "/fixture/repo/.git";
export const PROFILE_CATALOG_KEY = "profile";
export const EMPTY_CATALOG: ProjectCatalogFile = { schemaVersion: 2, projects: [], targets: [] };
export const EMPTY_WORKTREES: WorktreeCatalogFile = {
  schemaVersion: 1,
  bindings: [],
  workspaces: [],
  creationReceipts: [],
};

export interface FixtureCreateIntent {
  request: CreateWorkspaceRequest;
  candidate: WorktreeCandidate;
  workspace: WorktreeWorkspaceRecord;
  binding: RepositoryBindingRecord;
  registered: boolean;
}

export interface FixtureCounters {
  catalogReads: number;
  worktreeReads: number;
  hierarchyReads: number;
  availabilityReads: number;
  directoryReads: number;
  taskListReads: number;
  discoveryCalls: number;
  createProjectCalls: number;
  createProjectIds: string[];
  adoptionCalls: number;
  /** Calls to the legacy unscoped Catalog writer; V2 snapshot ingestion never increments this. */
  workspaceRefWrites: number;
  createWorkspaceCalls: CreateWorkspaceRequest[];
  summaryReadsByWorkspace: Record<string, number>;
}

export interface SidebarBrowserFixtureState {
  currentScope: string;
  firstProjectId?: string;
  catalogs: Map<string, ProjectCatalogFile>;
  worktrees: WorktreeCatalogFile;
  migration: SessionHierarchyFile;
  summaries: AgentHostSessionSummary[];
  tasks: ZCodeTaskMeta[];
  createIntents: Map<string, FixtureCreateIntent>;
  failNextWorkspaceRefWrites: number;
  failNextProjectCreates: number;
  failFirstCreateRegistration: boolean;
  failNextCreateCandidateMissing: boolean;
  unavailableDirectory: boolean;
  targetOffline: boolean;
  counters: FixtureCounters;
  eventListeners: Set<(event: { spec: AgentHostSessionSummary["spec"]; event: unknown }) => void>;
  heldCatalogReads: Array<() => void>;
  holdNextCatalogRead: boolean;
  selectedTasks: string[];
  nativeServiceCalls: Array<{ service: string; method: string; sessionId?: string }>;
  externalHostWorkspacePath?: string;
  externalSelectionEvents: string[];
}

export function evidence(path: string): FilesystemEvidence {
  return {
    canonicalPath: path,
    device: 1,
    inode: Math.abs(
      path.split("").reduce((value, character) => value * 31 + character.charCodeAt(0), 7),
    ),
    birthtimeMs: 1_700_000_000_000,
  };
}

export function makeBinding(
  projectId: string,
  id: string,
  commonDir = REPOSITORY_COMMON_DIR,
): RepositoryBindingRecord {
  return {
    schemaVersion: 1,
    id,
    projectId,
    executionTargetId: TARGET_ID,
    gitCommonDir: commonDir,
    commonDirEvidence: evidence(commonDir),
  };
}

export function makeWorkspace(params: {
  id: string;
  projectId: string;
  bindingId: string;
  title: string;
  path: string;
  main?: boolean;
  branch?: string;
  detached?: string;
}): WorktreeWorkspaceRecord {
  return {
    schemaVersion: 1,
    id: params.id,
    projectId: params.projectId,
    repositoryBindingId: params.bindingId,
    title: params.title,
    worktreePath: params.path,
    worktreeGeneration: `generation-${params.id}`,
    isMainWorktree: params.main ?? false,
    head: params.detached
      ? { kind: "detached", oid: params.detached }
      : { kind: "branch", ref: params.branch ?? "main", oid: null },
    origin: "adopted",
    lifecycle: "active",
    verification: "verified",
    filesystemEvidence: evidence(params.path),
  };
}

export function makeCandidate(
  path: string,
  options: { main?: boolean; branch?: string; repositoryCommonDir?: string } = {},
): WorktreeCandidate {
  const commonDir = options.repositoryCommonDir ?? REPOSITORY_COMMON_DIR;
  return {
    targetId: TARGET_ID,
    repositoryCommonDir: commonDir,
    commonDirEvidence: evidence(commonDir),
    worktreePath: path,
    filesystemEvidence: evidence(path),
    isMainWorktree: options.main ?? false,
    locked: false,
    head: { kind: "branch", ref: options.branch ?? "feature/ui", oid: null },
  };
}

export function makeMigration(records: SessionHierarchyFile["records"] = []): SessionHierarchyFile {
  return {
    schemaVersion: 1,
    source: {
      sourceKey: "fixture-session-index",
      fingerprint: "a".repeat(64),
      commandKey: "b".repeat(64),
    },
    records,
  };
}

export function makeSummary(params: {
  sessionId: string;
  workspacePath: string;
  harnessId?: string;
  title: string;
  status?: AgentHostSessionSummary["lastKnownStatus"];
  pendingInteractionCount?: number;
  updatedAt?: number;
}): AgentHostSessionSummary {
  const harnessId = params.harnessId ?? "pi";
  return {
    spec: {
      schemaVersion: 1,
      hostSessionId: params.sessionId,
      execution: {
        targetId: TARGET_ID,
        workspaceIdentity: params.workspacePath,
        worktreePath: params.workspacePath,
      },
      harness: { id: harnessId, adapterVersion: harnessId === "pi" ? "0.87.1" : "fixture" },
      modelBinding: { kind: "harness-managed" },
    },
    title: params.title,
    lastKnownStatus: params.status ?? "running",
    freshness: "live",
    recentOutcome: "unknown",
    pendingInteractionCount: params.pendingInteractionCount ?? 0,
    unread: false,
    updatedAt: params.updatedAt ?? 1_780_000_123_000,
    archived: false,
    kind: "top-level",
  };
}

export function makeDirectory(): HarnessDirectorySnapshot {
  return {
    schemaVersion: 1,
    targetId: TARGET_ID,
    status: "available",
    entries: [
      {
        manifest: {
          schemaVersion: 1,
          id: "zcode",
          name: "ZCode",
          adapterVersion: "native-v4",
          icon: { fallback: "initials" },
        },
        status: "registered",
        source: "native",
      },
      {
        manifest: {
          schemaVersion: 1,
          id: "pi",
          name: "Pi",
          adapterVersion: "0.87.1",
          icon: { fallback: "initials" },
        },
        status: "registered",
        source: "external",
      },
    ],
  };
}

export function emptyMigration(): SessionHierarchyFile {
  return makeMigration();
}

export function createFixtureState(): SidebarBrowserFixtureState {
  return {
    currentScope: "/fixture/repo",
    catalogs: new Map([[PROFILE_CATALOG_KEY, structuredClone(EMPTY_CATALOG)]]),
    worktrees: structuredClone(EMPTY_WORKTREES),
    migration: emptyMigration(),
    summaries: [],
    tasks: [],
    createIntents: new Map(),
    failNextWorkspaceRefWrites: 0,
    failNextProjectCreates: 0,
    failFirstCreateRegistration: true,
    failNextCreateCandidateMissing: false,
    unavailableDirectory: false,
    targetOffline: false,
    counters: {
      catalogReads: 0,
      worktreeReads: 0,
      hierarchyReads: 0,
      availabilityReads: 0,
      directoryReads: 0,
      taskListReads: 0,
      discoveryCalls: 0,
      createProjectCalls: 0,
      createProjectIds: [],
      adoptionCalls: 0,
      workspaceRefWrites: 0,
      createWorkspaceCalls: [],
      summaryReadsByWorkspace: {},
    },
    eventListeners: new Set(),
    heldCatalogReads: [],
    holdNextCatalogRead: false,
    selectedTasks: [],
    nativeServiceCalls: [],
    externalSelectionEvents: [],
  };
}

export function currentCatalog(state: SidebarBrowserFixtureState): ProjectCatalogFile {
  let catalog = state.catalogs.get(PROFILE_CATALOG_KEY);
  if (!catalog) {
    catalog = structuredClone(EMPTY_CATALOG);
    state.catalogs.set(PROFILE_CATALOG_KEY, catalog);
  }
  return catalog;
}

export function createSessionRecord(params: {
  hierarchySessionId: string;
  projectId: string;
  workspaceId: string;
  workspacePath: string;
  harnessId: string;
  ownerKind: "native-v4" | "agent-host";
}): SessionHierarchyFile["records"][number] {
  return {
    hierarchySessionId: params.hierarchySessionId,
    nativeSessionId: params.hierarchySessionId,
    ownerKind: params.ownerKind,
    targetId: TARGET_ID,
    projectId: params.projectId,
    workspaceId: params.workspaceId,
    harnessId: params.harnessId,
    workspacePath: params.workspacePath,
    ...(params.ownerKind === "agent-host" ? { workspaceIdentity: params.workspacePath } : {}),
    cwdRelativeToWorktree: params.ownerKind === "native-v4" ? "src" : ".",
    status: "linked",
  };
}
