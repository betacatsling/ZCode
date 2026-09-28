import type { IProjectCatalogService } from "@zcode/services/project-catalog";
import type {
  CreateWorkspaceRequest,
  IWorktreeService,
  WorktreeCandidate,
  WorktreeCreateResult,
  WorktreeWorkspaceRecord,
} from "@zcode/services/worktree";
import {
  assertCurrent,
  assertTargetWritable,
  candidateForCreatedWorkspace,
  createWorkspaceRequestSignature,
  ingestCurrentTargetSnapshot,
  maybeSetInitialDefault,
} from "./targetCatalogMutations.js";

async function ensureWorkspaceReference(params: {
  catalog: IProjectCatalogService;
  worktree: IWorktreeService;
  targetId: string;
  projectId: string;
  workspaceId: string;
  isCurrent?: () => boolean;
  wasEmpty?: boolean;
}): Promise<void> {
  assertCurrent(params.isCurrent);
  const catalogBefore = await params.catalog.read();
  const projectBefore = catalogBefore.projects.find((item) => item.id === params.projectId);
  if (!projectBefore) throw new Error("project-sidebar-binding-project-missing");
  await ingestCurrentTargetSnapshot({
    catalog: params.catalog,
    worktree: params.worktree,
    targetId: params.targetId,
    isCurrent: params.isCurrent,
  });
  await maybeSetInitialDefault({
    catalog: params.catalog,
    projectId: params.projectId,
    targetId: params.targetId,
    workspaceId: params.workspaceId,
    wasEmpty:
      params.wasEmpty ??
      (!projectBefore.defaultWorkspaceId && projectBefore.workspaceReferences.length === 0),
  });
}

export async function recoverWorkspaceCreation(params: {
  catalog: IProjectCatalogService | undefined;
  worktree: IWorktreeService | undefined;
  targetId: string;
  requestIds: Map<string, string>;
  request: CreateWorkspaceRequest;
  candidate: WorktreeCandidate;
  isCurrent?: () => boolean;
  refresh(): Promise<void>;
}): Promise<WorktreeWorkspaceRecord> {
  const { catalog, worktree, request, candidate } = params;
  if (!catalog || !worktree) throw new Error("project-sidebar-services-unavailable");
  const signature = `${params.targetId}\0${createWorkspaceRequestSignature(request)}`;
  if (params.requestIds.get(signature) !== request.requestId) {
    throw new Error("project-sidebar-stale-candidate");
  }
  assertCurrent(params.isCurrent);
  await assertTargetWritable(worktree, params.targetId);
  assertCurrent(params.isCurrent);
  const [catalogFile, worktreeFile] = await Promise.all([catalog.read(), worktree.read()]);
  assertCurrent(params.isCurrent);
  const project = catalogFile.projects.find((item) => item.id === request.projectId);
  if (!project) throw new Error("project-sidebar-binding-project-missing");
  const binding = worktreeFile.bindings.find((item) => item.id === request.repositoryBindingId);
  const expectedBranch = request.mode === "new-branch" ? request.newBranch : request.existingBranch;
  if (
    !binding ||
    binding.projectId !== request.projectId ||
    binding.executionTargetId !== params.targetId ||
    candidate.targetId !== params.targetId ||
    binding.gitCommonDir !== candidate.repositoryCommonDir ||
    candidate.worktreePath !== request.worktreePath ||
    candidate.head.kind !== "branch" ||
    candidate.head.ref !== expectedBranch
  ) {
    throw new Error("project-sidebar-stale-candidate");
  }
  const wasEmpty = !project.defaultWorkspaceId && project.workspaceReferences.length === 0;
  const adoption = await worktree.adopt(request.projectId, candidate, request.title);
  assertCurrent(params.isCurrent);
  await ensureWorkspaceReference({
    catalog,
    worktree,
    targetId: params.targetId,
    projectId: request.projectId,
    workspaceId: adoption.workspace.id,
    isCurrent: params.isCurrent,
    wasEmpty,
  });
  assertCurrent(params.isCurrent);
  await params.refresh();
  params.requestIds.delete(signature);
  return adoption.workspace;
}

export async function createWorkspace(params: {
  catalog: IProjectCatalogService | undefined;
  worktree: IWorktreeService | undefined;
  targetId: string;
  requestIds: Map<string, string>;
  request: CreateWorkspaceRequest;
  isCurrent?: () => boolean;
  refresh(): Promise<void>;
}): Promise<WorktreeCreateResult> {
  const { catalog, worktree, request } = params;
  if (!catalog || !worktree) throw new Error("project-sidebar-services-unavailable");
  const rawSignature = createWorkspaceRequestSignature(request);
  const signature = `${params.targetId}\0${rawSignature}`;
  const requestId = params.requestIds.get(signature) ?? request.requestId;
  params.requestIds.set(signature, requestId);
  assertCurrent(params.isCurrent);
  await assertTargetWritable(worktree, params.targetId);
  const [catalogBefore, worktreeBefore] = await Promise.all([catalog.read(), worktree.read()]);
  assertCurrent(params.isCurrent);
  const binding = worktreeBefore.bindings.find((item) => item.id === request.repositoryBindingId);
  const projectBefore = catalogBefore.projects.find((project) => project.id === request.projectId);
  if (
    !projectBefore ||
    !binding ||
    binding.projectId !== request.projectId ||
    binding.executionTargetId !== params.targetId
  ) {
    throw new Error("project-sidebar-stale-candidate");
  }
  const wasEmpty =
    !projectBefore.defaultWorkspaceId && projectBefore.workspaceReferences.length === 0;
  const stableRequest = { ...request, requestId } as CreateWorkspaceRequest;
  const result = await worktree.createWorkspace(stableRequest);
  if (result.status === "unregistered") return result;
  try {
    assertCurrent(params.isCurrent);
    await ensureWorkspaceReference({
      catalog,
      worktree,
      targetId: params.targetId,
      projectId: request.projectId,
      workspaceId: result.workspace.id,
      isCurrent: params.isCurrent,
      wasEmpty,
    });
  } catch (error) {
    return {
      status: "unregistered",
      requestId,
      candidate: candidateForCreatedWorkspace(result),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  assertCurrent(params.isCurrent);
  await params.refresh();
  params.requestIds.delete(signature);
  return result;
}
