import type { IProjectCatalogService } from "@zcode/services/project-catalog";
import type {
  CreateWorkspaceRequest,
  IWorktreeService,
  WorktreeCandidate,
  WorktreeCatalogFile,
  WorktreeCreateResult,
} from "@zcode/services/worktree";

export function assertCurrent(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) throw new Error("project-sidebar-stale-candidate");
}

export async function assertTargetWritable(
  worktree: IWorktreeService,
  targetId: string,
): Promise<void> {
  const availability = await worktree.getAvailability();
  if (availability.targetId !== targetId) throw new Error("project-sidebar-target-scope-mismatch");
  if (!availability.available || !availability.writable) {
    throw new Error("project-sidebar-target-offline");
  }
}

function nextObservedAt(
  catalogFile: Awaited<ReturnType<IProjectCatalogService["read"]>>,
  targetId: string,
): number {
  const current = catalogFile.targets.find((target) => target.targetId === targetId);
  return Math.max(
    Date.now(),
    (current?.lastVerifiedAt ?? 0) + 1,
    (current?.freshnessUpdatedAt ?? 0) + 1,
  );
}

function toTargetSnapshot(worktrees: WorktreeCatalogFile, targetId: string, observedAt: number) {
  return {
    schemaVersion: 1 as const,
    targetId,
    observedAt,
    bindings: worktrees.bindings.map(({ id, projectId, executionTargetId }) => ({
      id,
      projectId,
      executionTargetId,
    })),
    workspaces: worktrees.workspaces.map(
      ({
        id,
        projectId,
        repositoryBindingId,
        title,
        isMainWorktree,
        head,
        lifecycle,
        verification,
      }) => ({
        id,
        projectId,
        repositoryBindingId,
        title,
        isMainWorktree,
        head,
        lifecycle,
        verification,
      }),
    ),
    sessionSummaries: [],
  };
}

export async function ingestCurrentTargetSnapshot(params: {
  catalog: IProjectCatalogService;
  worktree: IWorktreeService;
  targetId: string;
  isCurrent?: () => boolean;
}): Promise<WorktreeCatalogFile> {
  assertCurrent(params.isCurrent);
  const [catalogFile, worktrees] = await Promise.all([
    params.catalog.read(),
    params.worktree.read(),
  ]);
  assertCurrent(params.isCurrent);
  const availability = await params.worktree.getAvailability();
  assertCurrent(params.isCurrent);
  if (availability.targetId !== params.targetId || !availability.available) {
    throw new Error("project-sidebar-target-scope-mismatch");
  }
  await params.catalog.ingestTargetSnapshot(
    toTargetSnapshot(worktrees, params.targetId, nextObservedAt(catalogFile, params.targetId)),
  );
  assertCurrent(params.isCurrent);
  return worktrees;
}

export async function maybeSetInitialDefault(params: {
  catalog: IProjectCatalogService;
  projectId: string;
  targetId: string;
  workspaceId: string;
  createdProject?: boolean;
  wasEmpty?: boolean;
}): Promise<void> {
  if (!params.createdProject && !params.wasEmpty) return;
  const catalogFile = await params.catalog.read();
  const project = catalogFile.projects.find((item) => item.id === params.projectId);
  if (
    project &&
    !project.defaultWorkspaceId &&
    project.workspaceReferences.length === 1 &&
    project.workspaceReferences[0]?.targetId === params.targetId &&
    project.workspaceReferences[0]?.workspaceId === params.workspaceId
  ) {
    await params.catalog.setDefaultWorkspaceRef(params.projectId, {
      targetId: params.targetId,
      workspaceId: params.workspaceId,
    });
  }
}

export function candidateForCreatedWorkspace(
  result: Extract<WorktreeCreateResult, { status: "created" | "already-present" }>,
): WorktreeCandidate {
  return {
    targetId: result.binding.executionTargetId,
    repositoryCommonDir: result.binding.gitCommonDir,
    commonDirEvidence: result.binding.commonDirEvidence,
    worktreePath: result.workspace.worktreePath,
    filesystemEvidence: result.workspace.filesystemEvidence,
    isMainWorktree: result.workspace.isMainWorktree,
    locked: false,
    head: result.workspace.head,
  };
}

export function createWorkspaceRequestSignature(request: CreateWorkspaceRequest): string {
  const { requestId: _requestId, ...requestFields } = request;
  return JSON.stringify(requestFields);
}
