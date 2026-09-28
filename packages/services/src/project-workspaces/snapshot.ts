import type {
  AgentSessionRecord,
  Project,
  RepositoryBinding,
  WorktreeWorkspace,
} from "./planTypes.js";
import { ProjectWorkspaceError } from "./errors.js";
import type { FilesystemIdentity } from "./ports.js";

export const SESSION_ACTIVITY_KINDS = [
  "idle",
  "starting",
  "running",
  "waiting",
  "cancelling",
] as const;
export const SESSION_CONNECTION_KINDS = ["live", "stale", "offline", "unknown"] as const;
export const SESSION_TURN_KINDS = ["succeeded", "failed", "unknown"] as const;

export type SessionActivityKind = (typeof SESSION_ACTIVITY_KINDS)[number];
export type SessionConnectionKind = (typeof SESSION_CONNECTION_KINDS)[number];
export type SessionTurnKind = (typeof SESSION_TURN_KINDS)[number];

/** 侧栏用的轻量活动摘要。离线重扫描只能把连接标过期，不能改活动和轮次结果。 */
export interface SessionActivitySummary {
  activity: SessionActivityKind;
  connection: SessionConnectionKind;
  lastTurn: SessionTurnKind;
  unread: boolean;
  pendingApproval: boolean;
  problem: boolean;
  unconfirmedError: boolean;
  internalChild: boolean;
  archived: boolean;
  topLevel: boolean;
}

export interface MigrationMapping {
  nativeSessionId: string;
  projectId: string | null;
  workspaceId: string | null;
  cwdRelative: string | null;
  harnessId: string | null;
  modelBinding: unknown;
  status: "linked" | "pending-verification";
  reason?: string;
}

export interface CatalogSnapshot {
  schemaVersion: 1;
  projects: Project[];
  bindings: RepositoryBinding[];
  workspaces: WorktreeWorkspace[];
  sessions: AgentSessionRecord[];
  sessionCwdById: Record<string, string>;
  workspaceIdentityById: Record<string, string>;
  evidenceByWorkspaceId: Record<string, FilesystemIdentity>;
  verificationByWorkspaceId: Record<string, "verified" | "needsVerification">;
  hiddenWorkspaceIds: string[];
  removedProjectIds: string[];
  archivedSessionIds: string[];
  stoppedSessionIds: string[];
  deletionByWorkspaceId: Record<string, { generation: string }>;
  freshnessByTargetId: Record<string, "live" | "stale" | "offline" | "unknown">;
  /** requestId → workspaceId。只有目录写入成功才记录。 */
  creationReceipts: Record<string, string>;
  /** bindingId → 最近一次成功扫描里尚未接管的候选数。失败扫描不写 0。 */
  unadoptedCountByBindingId: Record<string, number>;
  /** sessionId → 最近一次权威活动摘要。失败扫描不改写。 */
  sessionActivityById: Record<string, SessionActivitySummary>;
  migration: { schemaVersion: 1; fingerprint: string; mappings: MigrationMapping[] } | null;
}

const FRESHNESS = new Set(["live", "stale", "offline", "unknown"]);
const LIFECYCLE = new Set(["active", "archived", "missing", "removed"]);

export function emptySnapshot(): CatalogSnapshot {
  return {
    schemaVersion: 1,
    projects: [],
    bindings: [],
    workspaces: [],
    sessions: [],
    sessionCwdById: {},
    workspaceIdentityById: {},
    evidenceByWorkspaceId: {},
    verificationByWorkspaceId: {},
    hiddenWorkspaceIds: [],
    removedProjectIds: [],
    archivedSessionIds: [],
    stoppedSessionIds: [],
    deletionByWorkspaceId: {},
    freshnessByTargetId: {},
    creationReceipts: {},
    unadoptedCountByBindingId: {},
    sessionActivityById: {},
    migration: null,
  };
}

export function cloneSnapshot(snapshot: CatalogSnapshot): CatalogSnapshot {
  return structuredClone(snapshot);
}

function assertId(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new ProjectWorkspaceError(code);
  }
}

function unique(ids: readonly string[], code: string): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new ProjectWorkspaceError(code);
    seen.add(id);
  }
  return seen;
}

const ACTIVITY_KINDS = new Set<string>(SESSION_ACTIVITY_KINDS);
const CONNECTION_KINDS = new Set<string>(SESSION_CONNECTION_KINDS);
const TURN_KINDS = new Set<string>(SESSION_TURN_KINDS);

function assertActivitySummary(summary: SessionActivitySummary): void {
  if (!summary || typeof summary !== "object")
    throw new ProjectWorkspaceError("invalid-session-activity");
  if (!ACTIVITY_KINDS.has(summary.activity) || !CONNECTION_KINDS.has(summary.connection)) {
    throw new ProjectWorkspaceError("invalid-session-activity");
  }
  if (!TURN_KINDS.has(summary.lastTurn))
    throw new ProjectWorkspaceError("invalid-session-activity");
  for (const key of [
    "unread",
    "pendingApproval",
    "problem",
    "unconfirmedError",
    "internalChild",
    "archived",
    "topLevel",
  ] as const) {
    if (typeof summary[key] !== "boolean")
      throw new ProjectWorkspaceError("invalid-session-activity");
  }
}

function assertHead(head: WorktreeWorkspace["head"]): void {
  if (!head || (head.kind !== "branch" && head.kind !== "detached")) {
    throw new ProjectWorkspaceError("invalid-head");
  }
  if (head.kind === "branch") {
    assertId(head.ref, "invalid-head");
    if (head.oid !== null && (typeof head.oid !== "string" || head.oid.length === 0)) {
      throw new ProjectWorkspaceError("invalid-head");
    }
    return;
  }
  if (typeof head.oid !== "string" || head.oid.length === 0) {
    throw new ProjectWorkspaceError("invalid-head");
  }
}

function assertKeys(keys: readonly string[], allowed: ReadonlySet<string>, code: string): void {
  for (const key of keys) {
    if (!allowed.has(key)) throw new ProjectWorkspaceError(code);
  }
}

export function assertSnapshot(snapshot: CatalogSnapshot): void {
  if (snapshot.schemaVersion !== 1) throw new ProjectWorkspaceError("unsupported-schema");
  const projectIds = unique(
    snapshot.projects.map((project) => project.id),
    "duplicate-project",
  );
  const bindingIds = unique(
    snapshot.bindings.map((binding) => binding.id),
    "duplicate-binding",
  );
  const workspaceIds = unique(
    snapshot.workspaces.map((workspace) => workspace.id),
    "duplicate-workspace",
  );
  const sessionIds = unique(
    snapshot.sessions.map((session) => session.id),
    "duplicate-session",
  );
  for (const project of snapshot.projects) {
    assertId(project.id, "invalid-project");
    if (
      typeof project.name !== "string" ||
      project.name.trim() === "" ||
      project.name.length > 256
    ) {
      throw new ProjectWorkspaceError("invalid-project");
    }
    if (project.iconAssetId !== undefined) assertId(project.iconAssetId, "invalid-project");
    if (project.defaultWorkspaceId !== undefined) {
      assertId(project.defaultWorkspaceId, "invalid-project");
      const workspace = snapshot.workspaces.find((item) => item.id === project.defaultWorkspaceId);
      if (!workspace || workspace.projectId !== project.id) {
        throw new ProjectWorkspaceError("invalid-default-workspace");
      }
    }
  }
  for (const binding of snapshot.bindings) {
    assertId(binding.id, "invalid-binding");
    if (!projectIds.has(binding.projectId)) throw new ProjectWorkspaceError("invalid-binding");
    assertId(binding.executionTargetId, "invalid-binding");
    if (typeof binding.gitCommonDir !== "string" || binding.gitCommonDir.length === 0) {
      throw new ProjectWorkspaceError("invalid-binding");
    }
  }
  for (const workspace of snapshot.workspaces) {
    assertId(workspace.id, "invalid-workspace");
    if (!projectIds.has(workspace.projectId)) throw new ProjectWorkspaceError("invalid-workspace");
    const binding = snapshot.bindings.find((item) => item.id === workspace.repositoryBindingId);
    if (!binding || binding.projectId !== workspace.projectId) {
      throw new ProjectWorkspaceError("invalid-workspace");
    }
    if (!LIFECYCLE.has(workspace.lifecycle)) throw new ProjectWorkspaceError("invalid-workspace");
    if (workspace.origin !== "created" && workspace.origin !== "adopted") {
      throw new ProjectWorkspaceError("invalid-workspace");
    }
    if (typeof workspace.worktreePath !== "string" || workspace.worktreePath.length === 0) {
      throw new ProjectWorkspaceError("invalid-workspace");
    }
    assertId(workspace.worktreeGeneration, "invalid-workspace");
    if (typeof workspace.title !== "string" || workspace.title.trim() === "") {
      throw new ProjectWorkspaceError("invalid-workspace");
    }
    assertHead(workspace.head);
    if (!snapshot.evidenceByWorkspaceId[workspace.id]) {
      throw new ProjectWorkspaceError("missing-evidence");
    }
    const verification = snapshot.verificationByWorkspaceId[workspace.id];
    if (verification !== "verified" && verification !== "needsVerification") {
      throw new ProjectWorkspaceError("missing-verification");
    }
  }
  for (const session of snapshot.sessions) {
    assertId(session.id, "invalid-session");
    if (!workspaceIds.has(session.workspaceId)) throw new ProjectWorkspaceError("invalid-session");
    assertId(session.harnessId, "invalid-session");
    if (typeof session.title !== "string" || session.title.trim() === "") {
      throw new ProjectWorkspaceError("invalid-session");
    }
  }
  assertKeys(Object.keys(snapshot.sessionCwdById), sessionIds, "invalid-session-cwd");
  assertKeys(
    Object.keys(snapshot.workspaceIdentityById),
    workspaceIds,
    "invalid-workspace-identity",
  );
  assertKeys(Object.keys(snapshot.evidenceByWorkspaceId), workspaceIds, "invalid-evidence");
  assertKeys(Object.keys(snapshot.verificationByWorkspaceId), workspaceIds, "invalid-verification");
  assertKeys(Object.keys(snapshot.deletionByWorkspaceId), workspaceIds, "invalid-deletion-fence");
  for (const [requestId, workspaceId] of Object.entries(snapshot.creationReceipts)) {
    assertId(requestId, "invalid-receipt");
    if (!workspaceIds.has(workspaceId)) throw new ProjectWorkspaceError("invalid-receipt");
  }
  assertKeys(
    Object.keys(snapshot.unadoptedCountByBindingId),
    bindingIds,
    "invalid-unadopted-count",
  );
  assertKeys(
    Object.keys(snapshot.sessionActivityById ?? {}),
    sessionIds,
    "invalid-session-activity",
  );
  for (const summary of Object.values(snapshot.sessionActivityById ?? {})) {
    assertActivitySummary(summary);
  }
  for (const id of snapshot.hiddenWorkspaceIds) {
    if (!workspaceIds.has(id)) throw new ProjectWorkspaceError("invalid-hidden-workspace");
  }
  for (const id of snapshot.removedProjectIds) {
    if (!projectIds.has(id)) throw new ProjectWorkspaceError("invalid-removed-project");
  }
  for (const id of snapshot.archivedSessionIds) {
    if (!sessionIds.has(id)) throw new ProjectWorkspaceError("invalid-archived-session");
  }
  for (const id of snapshot.stoppedSessionIds) {
    if (!sessionIds.has(id)) throw new ProjectWorkspaceError("invalid-stopped-session");
  }
  for (const freshness of Object.values(snapshot.freshnessByTargetId)) {
    if (!FRESHNESS.has(freshness)) throw new ProjectWorkspaceError("invalid-freshness");
  }
  if (snapshot.migration) {
    if (snapshot.migration.schemaVersion !== 1)
      throw new ProjectWorkspaceError("unsupported-schema");
    if (!snapshot.migration.fingerprint) throw new ProjectWorkspaceError("invalid-migration");
  }
}
