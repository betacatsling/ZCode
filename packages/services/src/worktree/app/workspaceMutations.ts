import { isAbsolute } from "node:path";
import {
  createWorkspaceRequestSchema,
  updateWorkspaceRequestSchema,
  worktreeCatalogFileSchema,
  worktreeCreationReceiptSchema,
  worktreeWorkspaceRecordSchema,
  type CreateWorkspaceRequest,
  type RepositoryBindingRecord,
  type WorktreeCandidate,
  type WorktreeCatalogFile,
  type WorktreeCreateResult,
  type WorktreeDiscoveryResult,
  type WorktreeWorkspaceRecord,
  type UpdateWorkspaceRequest,
} from "../contract.js";
import { emptyWorktreeCatalogFile, parseWorktreeCatalog } from "../domain/state.js";
import { equalEvidence } from "./evidence.js";
import type { WorktreeServiceDependencies } from "./dependencies.js";

type Mutate = <T>(
  mutator: (current: WorktreeCatalogFile) => { state: WorktreeCatalogFile; result: T },
) => Promise<T>;

interface WorkspaceMutationDependencies extends WorktreeServiceDependencies {
  discover(inputPath: string): Promise<WorktreeDiscoveryResult>;
  enqueueWrite<T>(task: () => Promise<T>): Promise<T>;
  mutate: Mutate;
  idFactory: () => string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined
    : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
}

function gitFailure(label: string, result: { stderr: string; exitCode: number }): Error {
  return new Error(`${label}: ${result.stderr || `exit ${result.exitCode}`}`);
}

function candidateAtPath(
  discovery: Extract<WorktreeDiscoveryResult, { kind: "git" | "bare" }>,
  path: string,
): WorktreeCandidate | undefined {
  return discovery.candidates.find((candidate) => candidate.worktreePath === path);
}

function requestBranch(request: CreateWorkspaceRequest): string {
  return request.mode === "new-branch" ? request.newBranch : request.existingBranch;
}

async function assertRefExists(
  dependencies: WorktreeServiceDependencies,
  commonDir: string,
  ref: string,
): Promise<void> {
  const result = await dependencies.git.run([
    "-C",
    commonDir,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (result.exitCode !== 0) throw gitFailure(`invalid-base-ref:${ref}`, result);
}

async function assertBranchName(
  dependencies: WorktreeServiceDependencies,
  commonDir: string,
  branch: string,
): Promise<void> {
  const result = await dependencies.git.run([
    "-C",
    commonDir,
    "check-ref-format",
    "--branch",
    branch,
  ]);
  if (result.exitCode !== 0) throw gitFailure(`invalid-branch:${branch}`, result);
}

async function branchExists(
  dependencies: WorktreeServiceDependencies,
  commonDir: string,
  branch: string,
): Promise<boolean> {
  const result = await dependencies.git.run([
    "-C",
    commonDir,
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw gitFailure(`branch-check-failed:${branch}`, result);
}

async function registerCreatedCandidate(
  dependencies: WorkspaceMutationDependencies,
  request: CreateWorkspaceRequest,
  candidate: WorktreeCandidate,
  expectedTarget: string,
): Promise<{
  status: "created" | "already-present";
  binding: RepositoryBindingRecord;
  workspace: WorktreeWorkspaceRecord;
}> {
  let result!: {
    status: "created" | "already-present";
    binding: RepositoryBindingRecord;
    workspace: WorktreeWorkspaceRecord;
  };
  await dependencies.persistence.update((raw) => {
    const current = raw === null ? emptyWorktreeCatalogFile() : parseWorktreeCatalog(raw);
    const binding = current.bindings.find((item) => item.id === request.repositoryBindingId);
    if (!binding) throw new Error("unknown-repository-binding");
    if (binding.projectId !== request.projectId) throw new Error("binding-project-mismatch");
    if (binding.executionTargetId !== expectedTarget) throw new Error("foreign-target-binding");
    if (
      candidate.targetId !== expectedTarget ||
      candidate.repositoryCommonDir !== binding.gitCommonDir ||
      !equalEvidence(candidate.commonDirEvidence, binding.commonDirEvidence)
    ) {
      throw new Error("binding-needs-verification");
    }
    const samePath = current.workspaces.find(
      (item) => item.worktreePath === candidate.worktreePath,
    );
    if (samePath) {
      if (samePath.repositoryBindingId !== binding.id || samePath.projectId !== request.projectId)
        throw new Error("workspace-path-already-registered");
      const receipt = current.creationReceipts.find((item) => {
        const parsed = createWorkspaceRequestSchema.safeParse(item.request);
        return parsed.success && parsed.data.requestId === request.requestId;
      });
      if (!receipt || receipt.workspaceId !== samePath.id)
        throw new Error("workspace-path-already-registered-requires-adopt");
      const parsedRequest = createWorkspaceRequestSchema.parse(receipt.request);
      if (JSON.stringify(parsedRequest) !== JSON.stringify(request))
        throw new Error("request-id-reused-with-different-request");
      if (samePath.lifecycle === "removed")
        throw new Error("workspace-removed-requires-explicit-reverify");
      if (!equalEvidence(samePath.filesystemEvidence, candidate.filesystemEvidence))
        throw new Error("workspace-needs-verification");
      result = { status: "already-present", binding, workspace: samePath };
      return current;
    }
    const workspace = worktreeWorkspaceRecordSchema.parse({
      schemaVersion: 1,
      id: dependencies.idFactory(),
      projectId: request.projectId,
      repositoryBindingId: binding.id,
      title: request.title.trim(),
      worktreePath: candidate.worktreePath,
      worktreeGeneration: dependencies.idFactory(),
      isMainWorktree: candidate.isMainWorktree,
      head: candidate.head,
      origin: "created",
      lifecycle: "active",
      verification: "verified",
      filesystemEvidence: candidate.filesystemEvidence,
    });
    result = { status: "created", binding, workspace };
    const receipt = worktreeCreationReceiptSchema.parse({
      schemaVersion: 1,
      request,
      workspaceId: workspace.id,
    });
    return worktreeCatalogFileSchema.parse({
      ...current,
      workspaces: [...current.workspaces, workspace],
      creationReceipts: [...current.creationReceipts, receipt],
    });
  });
  return result;
}

async function withOperationLock<T>(
  dependencies: WorktreeServiceDependencies,
  task: () => Promise<T>,
): Promise<T> {
  return dependencies.operationLock ? dependencies.operationLock(task) : task();
}

export function createWorkspaceMutations(
  dependencies: WorkspaceMutationDependencies,
): Pick<import("../contract.js").IWorktreeService, "createWorkspace" | "updateWorkspace"> {
  async function createWorkspaceOperation(
    rawRequest: CreateWorkspaceRequest,
  ): Promise<WorktreeCreateResult> {
    const request = createWorkspaceRequestSchema.parse(rawRequest);
    const expectedTarget = dependencies.targetId().trim();
    if (!expectedTarget) throw new Error("target-id-required");
    if (!isAbsolute(request.worktreePath) || request.worktreePath.includes("\0"))
      throw new Error("absolute-worktree-path-required");
    const raw = await dependencies.persistence.read();
    const current = raw === null ? emptyWorktreeCatalogFile() : parseWorktreeCatalog(raw);
    const existingReceipt = current.creationReceipts.find((receipt) => {
      const parsed = createWorkspaceRequestSchema.safeParse(receipt.request);
      return parsed.success && parsed.data.requestId === request.requestId;
    });
    if (existingReceipt) {
      const parsedRequest = createWorkspaceRequestSchema.parse(existingReceipt.request);
      if (JSON.stringify(parsedRequest) !== JSON.stringify(request))
        throw new Error("request-id-reused-with-different-request");
      if (!current.workspaces.some((item) => item.id === existingReceipt.workspaceId))
        throw new Error("creation-receipt-stale");
    }
    const binding = current.bindings.find((item) => item.id === request.repositoryBindingId);
    if (!binding) throw new Error("unknown-repository-binding");
    if (binding.projectId !== request.projectId) throw new Error("binding-project-mismatch");
    if (binding.executionTargetId !== expectedTarget) throw new Error("foreign-target-binding");
    const commonEvidence = await dependencies.filesystem.identity(binding.gitCommonDir);
    if (!equalEvidence(commonEvidence, binding.commonDirEvidence))
      throw new Error("binding-needs-verification");
    const bindingDiscovery = await dependencies.discover(binding.gitCommonDir);
    if (bindingDiscovery.kind !== "git" && bindingDiscovery.kind !== "bare")
      throw new Error("binding-is-not-git");
    if (request.worktreePath === binding.gitCommonDir)
      throw new Error("bare-root-path-not-allowed");
    const branch = requestBranch(request);
    await assertBranchName(dependencies, binding.gitCommonDir, branch);
    let requestedCanonicalPath: string | undefined;
    try {
      requestedCanonicalPath = await dependencies.filesystem.realpath(request.worktreePath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    let candidate = requestedCanonicalPath
      ? candidateAtPath(bindingDiscovery, requestedCanonicalPath)
      : undefined;
    const candidateMatchesBranch =
      candidate?.head.kind === "branch" && candidate.head.ref === branch;
    if (!candidateMatchesBranch) {
      if (request.mode === "new-branch") {
        await assertRefExists(dependencies, binding.gitCommonDir, request.baseRef);
        if (await branchExists(dependencies, binding.gitCommonDir, branch))
          throw new Error("branch-already-exists");
      } else if (!(await branchExists(dependencies, binding.gitCommonDir, branch))) {
        throw new Error("existing-branch-not-found");
      }
    }
    if (
      !candidate &&
      request.mode === "existing-branch" &&
      bindingDiscovery.candidates.some(
        (item) => item.head.kind === "branch" && item.head.ref === branch,
      )
    ) {
      throw new Error("branch-already-checked-out");
    }
    if (
      candidate?.isMainWorktree &&
      !current.workspaces.some((item) => item.worktreePath === candidate!.worktreePath)
    ) {
      throw new Error("main-worktree-not-linkable");
    }
    if (candidate) {
      if (!existingReceipt) throw new Error("workspace-path-already-registered-requires-adopt");
      if (candidate.head.kind !== "branch" || candidate.head.ref !== branch)
        throw new Error("worktree-path-already-registered");
    } else if (requestedCanonicalPath) {
      throw new Error("worktree-path-occupied");
    } else {
      const hooksPath = dependencies.prepareHooksPath
        ? await dependencies.prepareHooksPath()
        : process.platform === "win32"
          ? (() => {
              throw new Error("controlled-hooks-path-required-on-windows");
            })()
          : "/dev/null";
      const addArgs = [
        "-c",
        `core.hooksPath=${hooksPath}`,
        "-C",
        binding.gitCommonDir,
        "worktree",
        "add",
        "-q",
      ];
      if (request.mode === "new-branch")
        addArgs.push("-b", branch, request.worktreePath, request.baseRef);
      else addArgs.push(request.worktreePath, branch);
      const added = await dependencies.git.run(addArgs);
      if (added.exitCode !== 0) throw gitFailure("git-worktree-add-failed", added);
      try {
        const after = await dependencies.discover(binding.gitCommonDir);
        if (after.kind !== "git" && after.kind !== "bare")
          return {
            status: "unregistered",
            requestId: request.requestId,
            candidate: null,
            error: "created-worktree-discovery-failed",
          };
        requestedCanonicalPath = await dependencies.filesystem.realpath(request.worktreePath);
        candidate = candidateAtPath(after, requestedCanonicalPath);
      } catch (error) {
        return {
          status: "unregistered",
          requestId: request.requestId,
          candidate: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!candidate)
        return {
          status: "unregistered",
          requestId: request.requestId,
          candidate: null,
          error: "created-worktree-not-found-after-discovery",
        };
    }
    try {
      const registered = await registerCreatedCandidate(
        dependencies,
        request,
        candidate,
        expectedTarget,
      );
      return { ...registered, requestId: request.requestId };
    } catch (error) {
      return {
        status: "unregistered",
        requestId: request.requestId,
        candidate,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function updateWorkspace(
    rawRequest: UpdateWorkspaceRequest,
  ): Promise<WorktreeWorkspaceRecord> {
    const request = updateWorkspaceRequestSchema.parse(rawRequest);
    return dependencies.mutate((current) => {
      const workspace = current.workspaces.find((item) => item.id === request.workspaceId);
      if (!workspace) throw new Error(`unknown-workspace:${request.workspaceId}`);
      if (request.operation === "rename") {
        const next = worktreeWorkspaceRecordSchema.parse({ ...workspace, title: request.title });
        return {
          state: worktreeCatalogFileSchema.parse({
            ...current,
            workspaces: current.workspaces.map((item) =>
              item.id === request.workspaceId ? next : item,
            ),
          }),
          result: next,
        };
      }
      if (request.operation === "archive") {
        if (workspace.lifecycle === "removed") throw new Error("workspace-removed-cannot-archive");
        const next = worktreeWorkspaceRecordSchema.parse({ ...workspace, lifecycle: "archived" });
        return {
          state: worktreeCatalogFileSchema.parse({
            ...current,
            workspaces: current.workspaces.map((item) =>
              item.id === request.workspaceId ? next : item,
            ),
          }),
          result: next,
        };
      }
      if (workspace.lifecycle !== "archived") throw new Error("workspace-not-archived");
      const next = worktreeWorkspaceRecordSchema.parse({ ...workspace, lifecycle: "active" });
      return {
        state: worktreeCatalogFileSchema.parse({
          ...current,
          workspaces: current.workspaces.map((item) =>
            item.id === request.workspaceId ? next : item,
          ),
        }),
        result: next,
      };
    });
  }

  return {
    createWorkspace: (request) =>
      withOperationLock(dependencies, () =>
        dependencies.enqueueWrite(() => createWorkspaceOperation(request)),
      ),
    updateWorkspace,
  };
}
