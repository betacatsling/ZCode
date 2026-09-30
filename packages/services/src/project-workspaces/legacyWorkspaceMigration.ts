import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  AgentSessionRecord,
  Project,
  RepositoryBinding,
  WorktreeWorkspace,
} from "./planTypes.js";
import { ProjectWorkspaceError } from "./errors.js";
import { workspaceIdentityKey } from "./identity.js";
import type { CatalogStore, FilesystemIdentity, MigrationBackupWriter } from "./ports.js";
import { cloneSnapshot, type CatalogSnapshot, type MigrationMapping } from "./snapshot.js";

const logger = createServiceLogger("project-workspaces");

export interface LegacySessionInput {
  source: "storage-index" | "open-tab";
  nativeSessionId: string;
  title: string;
  harnessId?: string;
  modelBinding?: unknown;
  workspacePath: string;
  workspaceIdentity?: string;
  executionTargetId?: string;
  cwd?: string;
  symlinkEscapes?: boolean;
  originUrl?: string;
  resolution:
    | {
        status: "git";
        worktreeRoot: string;
        gitCommonDir: string;
        isMainWorktree: boolean;
        head: WorktreeWorkspace["head"];
        evidence: FilesystemIdentity;
      }
    | { status: "non-git" }
    | { status: "missing" }
    | { status: "offline" }
    | { status: "rebuilt" };
}

export interface MigrationPlan {
  schemaVersion: 1;
  fingerprint: string;
  projects: Project[];
  bindings: RepositoryBinding[];
  workspaces: WorktreeWorkspace[];
  sessions: AgentSessionRecord[];
  sessionCwdById: Record<string, string>;
  workspaceIdentityById: Record<string, string>;
  evidenceByWorkspaceId: Record<string, FilesystemIdentity>;
  mappings: MigrationMapping[];
}

function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function projectName(commonDir: string): string {
  const parts = commonDir.split(/[/\\]/).filter(Boolean);
  const last = parts.at(-1) ?? "project";
  if (last === ".git") return parts.at(-2) || "project";
  const stripped = last.replace(/\.git$/, "");
  return stripped || parts.at(-2) || "project";
}

function relativeCwd(root: string, cwd: string): string | null {
  const remainder = relative(root, cwd);
  if (remainder.startsWith("..") || isAbsolute(remainder)) return null;
  if (remainder.split(/[/\\]/).includes("..")) return null;
  return remainder === "" ? "." : remainder.split(/[/\\]/).join("/");
}

function pending(
  session: LegacySessionInput,
  reason: string,
  harnessId: string | null,
): MigrationMapping {
  return {
    nativeSessionId: session.nativeSessionId,
    projectId: null,
    workspaceId: null,
    cwdRelative: null,
    harnessId,
    modelBinding: session.modelBinding,
    status: "pending-verification",
    reason,
  };
}

/**
 * 迁移只消费存储索引。当前打开的 tab 不能定义项目或 worktree 是否存在。
 * 分组键包含目标与身份键，避免同路径的两台主机或两份身份被并到一起。
 */
export function planLegacyMigration(
  sessions: readonly LegacySessionInput[],
  knownHarnessIds: readonly string[],
): MigrationPlan {
  const known = new Set(knownHarnessIds);
  const indexed = sessions.filter((session) => session.source === "storage-index");
  const fingerprint = createHash("sha256")
    .update(stableJson({ schemaVersion: 1, knownHarnessIds: [...known].sort(), sessions: indexed }))
    .digest("hex");
  const eligible: LegacySessionInput[] = [];
  const mappings: MigrationMapping[] = [];
  for (const session of indexed) {
    const harnessId = session.harnessId?.trim() || null;
    if (!session.executionTargetId?.trim()) {
      mappings.push(pending(session, "target-unavailable", harnessId));
      continue;
    }
    if (!harnessId || !known.has(harnessId)) {
      mappings.push(pending(session, "unknown-harness", harnessId));
      continue;
    }
    if (session.resolution.status !== "git") {
      const reason =
        session.resolution.status === "non-git"
          ? "plain-folder"
          : session.resolution.status === "rebuilt"
            ? "needs-verification"
            : session.resolution.status;
      mappings.push(pending(session, reason, harnessId));
      continue;
    }
    if (session.symlinkEscapes) {
      mappings.push(pending(session, "cwd-escapes", harnessId));
      continue;
    }
    eligible.push(session);
  }
  const pathClaims = new Map<string, Set<string>>();
  for (const session of eligible) {
    if (session.resolution.status !== "git") continue;
    const claim = `${session.executionTargetId}\0${session.resolution.worktreeRoot}`;
    const keys = pathClaims.get(claim) ?? new Set<string>();
    keys.add(
      workspaceIdentityKey({
        workspaceIdentity: session.workspaceIdentity,
        workspacePath: session.workspacePath,
      }),
    );
    pathClaims.set(claim, keys);
  }
  const projects = new Map<string, Project>();
  const bindings = new Map<string, RepositoryBinding>();
  const workspaces = new Map<string, WorktreeWorkspace>();
  const identities: Record<string, string> = {};
  const evidence: Record<string, FilesystemIdentity> = {};
  const sessionRecords: AgentSessionRecord[] = [];
  const sessionCwdById: Record<string, string> = {};
  for (const session of eligible) {
    if (session.resolution.status !== "git") continue;
    const targetId = session.executionTargetId?.trim();
    const harnessId = session.harnessId?.trim();
    if (!targetId || !harnessId) continue;
    const identity = workspaceIdentityKey({
      workspaceIdentity: session.workspaceIdentity,
      workspacePath: session.workspacePath,
    });
    const claim = pathClaims.get(`${targetId}\0${session.resolution.worktreeRoot}`);
    if (claim && claim.size > 1) {
      mappings.push(pending(session, "identity-conflict", harnessId));
      continue;
    }
    let cwdRelative: string | null = null;
    if (session.cwd) {
      cwdRelative = relativeCwd(session.resolution.worktreeRoot, session.cwd);
      if (!cwdRelative) {
        mappings.push(pending(session, "cwd-escapes", harnessId));
        continue;
      }
    }
    const projectId = stableUuid(`project:${targetId}:${session.resolution.gitCommonDir}`);
    const bindingId = stableUuid(`binding:${targetId}:${session.resolution.gitCommonDir}`);
    const workspaceId = stableUuid(
      `workspace:${targetId}:${session.resolution.gitCommonDir}:${session.resolution.worktreeRoot}:${identity}`,
    );
    projects.set(projectId, {
      schemaVersion: 1,
      id: projectId,
      name: projectName(session.resolution.gitCommonDir),
    });
    bindings.set(bindingId, {
      schemaVersion: 1,
      id: bindingId,
      projectId,
      executionTargetId: targetId,
      gitCommonDir: session.resolution.gitCommonDir,
    });
    workspaces.set(workspaceId, {
      schemaVersion: 1,
      id: workspaceId,
      projectId,
      repositoryBindingId: bindingId,
      title: session.resolution.worktreeRoot.split(/[/\\]/).filter(Boolean).at(-1) || workspaceId,
      worktreePath: session.resolution.worktreeRoot,
      worktreeGeneration: stableUuid(`generation:${workspaceId}`),
      isMainWorktree: session.resolution.isMainWorktree,
      head: session.resolution.head,
      origin: "adopted",
      lifecycle: "active",
      verification: "verified",
    });
    if (session.workspaceIdentity?.trim())
      identities[workspaceId] = session.workspaceIdentity.trim();
    evidence[workspaceId] = session.resolution.evidence;
    if (cwdRelative) sessionCwdById[session.nativeSessionId] = cwdRelative;
    sessionRecords.push({
      schemaVersion: 1,
      id: session.nativeSessionId,
      workspaceId,
      harnessId,
      title: session.title,
    });
    mappings.push({
      nativeSessionId: session.nativeSessionId,
      projectId,
      workspaceId,
      cwdRelative,
      harnessId,
      modelBinding: session.modelBinding,
      status: "linked",
    });
  }
  return {
    schemaVersion: 1,
    fingerprint,
    projects: [...projects.values()],
    bindings: [...bindings.values()],
    workspaces: [...workspaces.values()],
    sessions: sessionRecords,
    sessionCwdById,
    workspaceIdentityById: identities,
    evidenceByWorkspaceId: evidence,
    mappings,
  };
}

function applyPlan(snapshot: CatalogSnapshot, plan: MigrationPlan): CatalogSnapshot {
  const next = cloneSnapshot(snapshot);
  for (const project of plan.projects) {
    if (!next.projects.some((item) => item.id === project.id)) next.projects.push(project);
  }
  for (const binding of plan.bindings) {
    const clash = next.bindings.find(
      (item) =>
        item.executionTargetId === binding.executionTargetId &&
        item.gitCommonDir === binding.gitCommonDir &&
        item.id !== binding.id,
    );
    if (clash) throw new ProjectWorkspaceError("binding-owned-by-other-project");
    if (!next.bindings.some((item) => item.id === binding.id)) next.bindings.push(binding);
  }
  for (const workspace of plan.workspaces) {
    if (!next.workspaces.some((item) => item.id === workspace.id)) {
      next.workspaces.push(workspace);
      const workspaceEvidence = plan.evidenceByWorkspaceId[workspace.id];
      if (!workspaceEvidence) throw new ProjectWorkspaceError("missing-evidence");
      next.evidenceByWorkspaceId[workspace.id] = workspaceEvidence;
      next.verificationByWorkspaceId[workspace.id] = "verified";
      const identity = plan.workspaceIdentityById[workspace.id];
      if (identity) next.workspaceIdentityById[workspace.id] = identity;
    }
  }
  for (const session of plan.sessions) {
    if (!next.sessions.some((item) => item.id === session.id)) next.sessions.push(session);
    const cwd = plan.sessionCwdById[session.id];
    if (cwd && !next.sessionCwdById[session.id]) next.sessionCwdById[session.id] = cwd;
  }
  next.migration = { schemaVersion: 1, fingerprint: plan.fingerprint, mappings: plan.mappings };
  return next;
}

export function createLegacyWorkspaceMigration(deps: {
  store: CatalogStore;
  knownHarnessIds: readonly string[];
}) {
  return {
    plan(sessions: readonly LegacySessionInput[]): MigrationPlan {
      return planLegacyMigration(sessions, deps.knownHarnessIds);
    },
    /**
     * dry-run 是 `plan()`。`apply` 先把当前目录快照交给 backup，再写映射。
     * 不删除 Git、工作区文件或 native session 正文。
     */
    async apply(
      sessions: readonly LegacySessionInput[],
      options: { backup: MigrationBackupWriter },
    ): Promise<MigrationPlan> {
      // 没有可恢复的目录副本时不能开始写映射；调用方漏传 options 与漏传 backup 一样拒绝。
      if (!options?.backup) throw new ProjectWorkspaceError("backup-required");
      const plan = planLegacyMigration(sessions, deps.knownHarnessIds);
      const current = await deps.store.read();
      await options.backup.write({
        schemaVersion: 1,
        fingerprint: plan.fingerprint,
        catalog: cloneSnapshot(current),
      });
      if (current.migration?.fingerprint === plan.fingerprint) return plan;
      await deps.store.update((snapshot) => ({
        snapshot: applyPlan(snapshot, plan),
        result: plan,
      }));
      logger.info(undefined, "legacy-workspace-migrated", {
        projects: plan.projects.length,
        sessions: plan.sessions.length,
        pending: plan.mappings.filter((mapping) => mapping.status === "pending-verification")
          .length,
      });
      return plan;
    },
  };
}
