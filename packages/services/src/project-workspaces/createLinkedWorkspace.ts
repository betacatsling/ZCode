import { basename, dirname } from "node:path";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { RepositoryBinding, WorktreeWorkspace } from "./planTypes.js";
import { ProjectWorkspaceError } from "./errors.js";
import { assertSafeGitRef } from "./identity.js";
import type { DiscoveredWorktree } from "./discovery.js";
import { parsePorcelainZ } from "./porcelain.js";
import type { ProjectWorkspaceDeps } from "./ports.js";
import type { CatalogSnapshot } from "./snapshot.js";

const logger = createServiceLogger("project-workspaces");

export type CreateWorkspaceResult =
  | { status: "created" | "already-present"; binding: RepositoryBinding; workspace: WorktreeWorkspace }
  | { status: "unregistered"; requestId: string; candidate: DiscoveredWorktree };

export interface CreateWorkspaceInput {
  requestId: string;
  projectId: string;
  repositoryBindingId: string;
  title: string;
  worktreePath: string;
  mode: "new-branch" | "existing-branch";
  branch: string;
  baseRef?: string;
}

export function workspaceRecord(
  deps: ProjectWorkspaceDeps,
  input: {
    projectId: string;
    bindingId: string;
    title: string;
    candidate: DiscoveredWorktree;
    origin: WorktreeWorkspace["origin"];
    workspaceIdentity?: string;
  },
): {
  snapshotPatch: Pick<
    CatalogSnapshot,
    "workspaces" | "evidenceByWorkspaceId" | "verificationByWorkspaceId" | "workspaceIdentityById"
  >;
  workspace: WorktreeWorkspace;
} {
  const workspace: WorktreeWorkspace = {
    id: deps.idFactory(),
    projectId: input.projectId,
    repositoryBindingId: input.bindingId,
    title: input.title.trim() || basename(input.candidate.worktreePath),
    worktreePath: input.candidate.worktreePath,
    worktreeGeneration: deps.idFactory(),
    isMainWorktree: input.candidate.isMainWorktree,
    head: input.candidate.head,
    origin: input.origin,
    lifecycle: "active",
  };
  return {
    workspace,
    snapshotPatch: {
      workspaces: [workspace],
      evidenceByWorkspaceId: { [workspace.id]: input.candidate.evidence },
      verificationByWorkspaceId: { [workspace.id]: "verified" },
      workspaceIdentityById: input.workspaceIdentity?.trim()
        ? { [workspace.id]: input.workspaceIdentity.trim() }
        : {},
    },
  };
}

/** 显式新建 linked worktree。参数走 argv，不拼接 shell。 */
export async function createLinkedWorkspace(
  deps: ProjectWorkspaceDeps,
  input: CreateWorkspaceInput,
): Promise<CreateWorkspaceResult> {
  assertSafeGitRef(input.branch);
  if (input.mode === "new-branch") {
    if (!input.baseRef) throw new ProjectWorkspaceError("invalid-base-ref");
    assertSafeGitRef(input.baseRef);
  }
  const title = input.title.trim();
  if (!title || !input.worktreePath) throw new ProjectWorkspaceError("invalid-workspace");
  const prepared = await deps.store.read();
  const receipt = prepared.creationReceipts[input.requestId];
  if (receipt) {
    const workspace = prepared.workspaces.find((item) => item.id === receipt);
    const binding = prepared.bindings.find((item) => item.id === workspace?.repositoryBindingId);
    if (!workspace || !binding) throw new ProjectWorkspaceError("invalid-receipt");
    return { status: "already-present", workspace, binding };
  }
  const binding = prepared.bindings.find((item) => item.id === input.repositoryBindingId);
  if (!binding || binding.projectId !== input.projectId) throw new ProjectWorkspaceError("unknown-binding");
  if (binding.executionTargetId !== deps.executionTargetId) throw new ProjectWorkspaceError("foreign-target");
  const parentAccess = await deps.filesystem.access(dirname(input.worktreePath));
  if (parentAccess !== "ok") throw new ProjectWorkspaceError("permission-denied");
  const listed = await deps.git.run(["--git-dir", binding.gitCommonDir, "worktree", "list", "--porcelain", "-z"]);
  if (listed.exitCode !== 0) throw new ProjectWorkspaceError("scan-failed");
  const records = parsePorcelainZ(listed.stdout);
  if (await deps.filesystem.exists(input.worktreePath)) {
    return existingPath(deps, input, prepared, binding, records);
  }
  if (records.some((record) => record.head.kind === "branch" && record.head.ref === input.branch)) {
    throw new ProjectWorkspaceError("branch-checked-out");
  }
  const baseRef = input.baseRef;
  const verifyRef = input.mode === "new-branch" ? baseRef : `refs/heads/${input.branch}`;
  if (!verifyRef) throw new ProjectWorkspaceError("invalid-base-ref");
  const verified = await deps.git.run([
    "--git-dir",
    binding.gitCommonDir,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${verifyRef}^{commit}`,
  ]);
  if (verified.exitCode !== 0) throw new ProjectWorkspaceError("invalid-base-ref");
  if (input.mode === "new-branch") {
    const existingBranch = await deps.git.run([
      "--git-dir",
      binding.gitCommonDir,
      "show-ref",
      "--verify",
      "--",
      `refs/heads/${input.branch}`,
    ]);
    if (existingBranch.exitCode === 0) throw new ProjectWorkspaceError("branch-exists");
  }
  const addArgs =
    input.mode === "new-branch"
      ? [
          "-c",
          "core.hooksPath=/dev/null",
          "--git-dir",
          binding.gitCommonDir,
          "worktree",
          "add",
          "-b",
          input.branch,
          input.worktreePath,
          verifyRef,
        ]
      : [
          "-c",
          "core.hooksPath=/dev/null",
          "--git-dir",
          binding.gitCommonDir,
          "worktree",
          "add",
          input.worktreePath,
          input.branch,
        ];
  const added = await deps.git.run(addArgs);
  if (added.exitCode !== 0) throw new ProjectWorkspaceError("git-worktree-add-failed");
  let evidence;
  try {
    evidence = await deps.filesystem.identity(await deps.filesystem.realpath(input.worktreePath));
  } catch {
    return unregistered(deps, input, binding, input.worktreePath, { kind: "branch", ref: input.branch, oid: null }, false, {
      device: null,
      inode: null,
    });
  }
  const candidate: DiscoveredWorktree = {
    executionTargetId: deps.executionTargetId,
    worktreePath: input.worktreePath,
    gitCommonDir: binding.gitCommonDir,
    isMainWorktree: false,
    head: { kind: "branch", ref: input.branch, oid: null },
    locked: false,
    evidence,
    commonDirEvidence: evidence,
  };
  try {
    return await deps.store.update((snapshot) => {
      const created = workspaceRecord(deps, {
        projectId: input.projectId,
        bindingId: binding.id,
        title,
        candidate,
        origin: "created",
      });
      return {
        snapshot: {
          ...snapshot,
          workspaces: [...snapshot.workspaces, created.workspace],
          evidenceByWorkspaceId: { ...snapshot.evidenceByWorkspaceId, ...created.snapshotPatch.evidenceByWorkspaceId },
          verificationByWorkspaceId: {
            ...snapshot.verificationByWorkspaceId,
            ...created.snapshotPatch.verificationByWorkspaceId,
          },
          creationReceipts: { ...snapshot.creationReceipts, [input.requestId]: created.workspace.id },
        },
        result: { status: "created" as const, binding, workspace: created.workspace },
      };
    });
  } catch (error) {
    logger.warn(undefined, "worktree-unregistered", {
      requestId: input.requestId,
      code: error instanceof Error ? error.message : "unknown",
    });
    return { status: "unregistered", requestId: input.requestId, candidate };
  }
}

async function existingPath(
  deps: ProjectWorkspaceDeps,
  input: CreateWorkspaceInput,
  prepared: CatalogSnapshot,
  binding: RepositoryBinding,
  records: ReturnType<typeof parsePorcelainZ>,
): Promise<CreateWorkspaceResult> {
  const canonical = await deps.filesystem.realpath(input.worktreePath);
  const listedHere = records.find((record) => record.path === canonical || record.path === input.worktreePath);
  const registered = prepared.workspaces.find(
    (workspace) =>
      workspace.repositoryBindingId === binding.id &&
      (workspace.worktreePath === canonical || workspace.worktreePath === input.worktreePath),
  );
  if (registered) return { status: "already-present", workspace: registered, binding };
  if (!listedHere) throw new ProjectWorkspaceError("path-occupied");
  const evidence = await deps.filesystem.identity(canonical);
  return unregistered(deps, input, binding, canonical, listedHere.head, listedHere.locked, evidence);
}

function unregistered(
  deps: ProjectWorkspaceDeps,
  input: CreateWorkspaceInput,
  binding: RepositoryBinding,
  worktreePath: string,
  head: WorktreeWorkspace["head"],
  locked: boolean,
  evidence: { device: number | null; inode: number | null },
): CreateWorkspaceResult {
  return {
    status: "unregistered",
    requestId: input.requestId,
    candidate: {
      executionTargetId: deps.executionTargetId,
      worktreePath,
      gitCommonDir: binding.gitCommonDir,
      isMainWorktree: false,
      head,
      locked,
      evidence,
      commonDirEvidence: evidence,
    },
  };
}
