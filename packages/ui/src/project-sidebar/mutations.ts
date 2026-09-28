import type { IProjectCatalogService } from "@zcode/services/project-catalog";
import type {
  BareRepositoryAdoptionRequest,
  IWorktreeService,
  WorktreeCandidate,
  WorktreeCatalogFile,
  WorktreeWorkspaceRecord,
} from "@zcode/services/worktree";
import type {
  ProjectSidebarBareRepositoryCandidate,
  ProjectSidebarCandidate,
  ProjectSidebarImportResult,
  ProjectSidebarImportSelection,
} from "./contract.js";
import {
  assertCurrent,
  assertTargetWritable,
  ingestCurrentTargetSnapshot,
  maybeSetInitialDefault,
} from "./targetCatalogMutations.js";

export interface PendingAdoption {
  targetId: string;
  name: string;
  path: string;
  /** 用户最初选择的 Project；解析现有 binding 的 owner 不得改写这个重试 key。 */
  requestedProjectId: string | null;
  projectId: string;
  candidates: readonly ProjectSidebarCandidate[];
  bareCandidate?: ProjectSidebarBareRepositoryCandidate;
  isNewProject: boolean;
  createdProject: boolean;
  selectedCandidateKey?: string;
  adoptedWorkspace?: WorktreeWorkspaceRecord;
}

function newProjectId(): string {
  // 浏览器 Crypto.randomUUID 依赖 this 绑定，不能先取出函数再裸调用。
  return `project-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function candidateKey(candidate: WorktreeCandidate): string {
  return `${candidate.targetId}\0${candidate.repositoryCommonDir}\0${candidate.worktreePath}`;
}

function worktreeCandidate(candidate: ProjectSidebarCandidate): WorktreeCandidate {
  // existingProject/bindingProjectMissing 只供候选 UI 展示，不能传入严格校验的 Worktree port。
  const {
    existingProject: _existingProject,
    bindingProjectMissing: _bindingProjectMissing,
    ...worktreeCandidateValue
  } = candidate;
  return worktreeCandidateValue;
}

function annotateCandidates(
  candidates: readonly WorktreeCandidate[],
  worktrees: WorktreeCatalogFile,
  catalogFile: Awaited<ReturnType<IProjectCatalogService["read"]>>,
): readonly ProjectSidebarCandidate[] {
  return candidates.map((candidate) => {
    const binding = worktrees.bindings.find(
      (item) =>
        item.executionTargetId === candidate.targetId &&
        item.gitCommonDir === candidate.repositoryCommonDir,
    );
    const owner = binding
      ? catalogFile.projects.find((project) => project.id === binding.projectId)
      : undefined;
    return {
      ...candidate,
      ...(owner ? { existingProject: { projectId: owner.id, name: owner.name } } : {}),
      ...(binding && !owner ? { bindingProjectMissing: true } : {}),
    } satisfies ProjectSidebarCandidate;
  });
}

function annotateBareCandidate(
  discovery: Extract<Awaited<ReturnType<IWorktreeService["discover"]>>, { kind: "bare" }>,
  worktrees: WorktreeCatalogFile,
  catalogFile: Awaited<ReturnType<IProjectCatalogService["read"]>>,
): ProjectSidebarBareRepositoryCandidate {
  const binding = worktrees.bindings.find(
    (item) =>
      item.executionTargetId === discovery.targetId &&
      item.gitCommonDir === discovery.repositoryCommonDir,
  );
  const owner = binding
    ? catalogFile.projects.find((project) => project.id === binding.projectId)
    : undefined;
  return {
    kind: "bare-repository",
    targetId: discovery.targetId,
    inputPath: discovery.inputPath,
    repositoryCommonDir: discovery.repositoryCommonDir,
    commonDirEvidence: discovery.commonDirEvidence,
    ...(owner ? { existingProject: { projectId: owner.id, name: owner.name } } : {}),
    ...(binding && !owner ? { bindingProjectMissing: true } : {}),
  };
}

function sameBareCandidate(
  left: ProjectSidebarBareRepositoryCandidate | undefined,
  right: ProjectSidebarBareRepositoryCandidate,
): boolean {
  return Boolean(
    left &&
    left.targetId === right.targetId &&
    left.inputPath === right.inputPath &&
    left.repositoryCommonDir === right.repositoryCommonDir &&
    JSON.stringify(left.commonDirEvidence) === JSON.stringify(right.commonDirEvidence),
  );
}

async function resolveProjectForAdoption(params: {
  catalog: IProjectCatalogService;
  worktree: IWorktreeService;
  pending: PendingAdoption;
  candidate: WorktreeCandidate | ProjectSidebarBareRepositoryCandidate;
  isCurrent?: () => boolean;
}): Promise<string> {
  assertCurrent(params.isCurrent);
  const [worktrees, catalogFile] = await Promise.all([
    params.worktree.read(),
    params.catalog.read(),
  ]);
  assertCurrent(params.isCurrent);
  const repositoryCommonDir = params.candidate.repositoryCommonDir;
  const existingProject =
    "existingProject" in params.candidate ? params.candidate.existingProject : undefined;
  const binding = worktrees.bindings.find(
    (item) =>
      item.executionTargetId === params.candidate.targetId &&
      item.gitCommonDir === repositoryCommonDir,
  );
  let projectId = params.pending.projectId;
  let project = catalogFile.projects.find((item) => item.id === projectId);
  if (binding && binding.projectId !== projectId) {
    const owner = catalogFile.projects.find((item) => item.id === binding.projectId);
    if (!owner) throw new Error("project-sidebar-binding-project-missing");
    if (
      !params.pending.isNewProject ||
      params.pending.createdProject ||
      params.pending.adoptedWorkspace
    ) {
      throw new Error(`project-sidebar-binding-owned-by-another-project:${owner.name}`);
    }
    if (existingProject?.projectId !== owner.id) {
      throw new Error(`project-sidebar-binding-owned-by-another-project:${owner.name}`);
    }
    projectId = owner.id;
    project = owner;
    params.pending.isNewProject = false;
    params.pending.createdProject = false;
  }
  if (existingProject && binding?.projectId !== existingProject.projectId) {
    throw new Error("project-sidebar-stale-candidate");
  }
  if (!params.pending.isNewProject && !project) {
    throw new Error("project-sidebar-binding-project-missing");
  }
  params.pending.projectId = projectId;
  return projectId;
}

async function ensureProjectForPending(params: {
  catalog: IProjectCatalogService;
  pending: PendingAdoption;
}): Promise<void> {
  const catalogFile = await params.catalog.read();
  const existing = catalogFile.projects.find((project) => project.id === params.pending.projectId);
  if (existing) {
    if (params.pending.isNewProject) params.pending.createdProject = true;
    return;
  }
  if (!params.pending.isNewProject) throw new Error("project-sidebar-binding-project-missing");
  await params.catalog.createProject({
    id: params.pending.projectId,
    name: params.pending.name,
  });
  params.pending.createdProject = true;
}

export async function addProjectAndAdopt(params: {
  catalog: IProjectCatalogService | undefined;
  worktree: IWorktreeService | undefined;
  targetId: string;
  pendingRef: { current: PendingAdoption | null };
  name: string;
  worktreePath: string;
  selection?: ProjectSidebarImportSelection;
  existingProjectId?: string;
  isCurrent?: () => boolean;
  refresh(): Promise<void>;
}): Promise<ProjectSidebarImportResult> {
  const { catalog, worktree } = params;
  if (!catalog || !worktree) throw new Error("project-sidebar-services-unavailable");
  const normalizedName = params.name.trim();
  if ((!params.existingProjectId && !normalizedName) || !params.worktreePath.trim()) {
    throw new Error("project-sidebar-input-required");
  }
  assertCurrent(params.isCurrent);
  await assertTargetWritable(worktree, params.targetId);
  assertCurrent(params.isCurrent);

  const currentPending = params.pendingRef.current;
  const pending =
    currentPending?.targetId === params.targetId &&
    currentPending.name === normalizedName &&
    currentPending.path === params.worktreePath &&
    currentPending.requestedProjectId === (params.existingProjectId ?? null)
      ? currentPending
      : null;

  if (!params.selection) {
    const [discovery, worktreeFile, catalogFile] = await Promise.all([
      worktree.discover(params.worktreePath),
      worktree.read(),
      catalog.read(),
    ]);
    assertCurrent(params.isCurrent);
    if (discovery.targetId !== params.targetId)
      throw new Error("project-sidebar-target-scope-mismatch");
    if (discovery.kind !== "git" && discovery.kind !== "bare") {
      throw new Error(`project-sidebar-discovery-${discovery.kind}`);
    }
    if (discovery.kind === "bare" && discovery.candidates.length === 0) {
      const bareCandidate = annotateBareCandidate(discovery, worktreeFile, catalogFile);
      params.pendingRef.current = {
        targetId: params.targetId,
        name: normalizedName,
        path: params.worktreePath,
        requestedProjectId: pending?.requestedProjectId ?? params.existingProjectId ?? null,
        projectId: pending?.projectId ?? params.existingProjectId ?? newProjectId(),
        candidates: [],
        bareCandidate,
        isNewProject: pending?.isNewProject ?? !params.existingProjectId,
        createdProject: pending?.createdProject ?? false,
        ...(pending?.adoptedWorkspace ? { adoptedWorkspace: pending.adoptedWorkspace } : {}),
      };
      return { status: "bare-repository", candidate: bareCandidate };
    }
    if (discovery.candidates.length === 0) throw new Error("project-sidebar-no-worktree-candidate");
    const candidates = annotateCandidates(discovery.candidates, worktreeFile, catalogFile);
    params.pendingRef.current = {
      targetId: params.targetId,
      name: normalizedName,
      path: params.worktreePath,
      requestedProjectId: pending?.requestedProjectId ?? params.existingProjectId ?? null,
      projectId: pending?.projectId ?? params.existingProjectId ?? newProjectId(),
      candidates,
      isNewProject: pending?.isNewProject ?? !params.existingProjectId,
      createdProject: pending?.createdProject ?? false,
      ...(pending?.selectedCandidateKey
        ? { selectedCandidateKey: pending.selectedCandidateKey }
        : {}),
      ...(pending?.adoptedWorkspace ? { adoptedWorkspace: pending.adoptedWorkspace } : {}),
    };
    return { status: "choices", candidates };
  }

  if (!pending || !params.pendingRef.current) throw new Error("project-sidebar-stale-candidate");
  if (params.selection.kind === "bare-repository") {
    const bare = params.selection.candidate;
    if (
      bare.bindingProjectMissing ||
      bare.targetId !== params.targetId ||
      !sameBareCandidate(pending.bareCandidate, bare)
    ) {
      throw new Error(
        bare.bindingProjectMissing
          ? "project-sidebar-binding-project-missing"
          : "project-sidebar-stale-candidate",
      );
    }
    const selectedProjectId = await resolveProjectForAdoption({
      catalog,
      worktree,
      pending,
      candidate: bare,
      isCurrent: params.isCurrent,
    });
    await ensureProjectForPending({ catalog, pending });
    assertCurrent(params.isCurrent);
    const bareRequest: BareRepositoryAdoptionRequest = {
      targetId: bare.targetId,
      inputPath: bare.inputPath,
      repositoryCommonDir: bare.repositoryCommonDir,
      commonDirEvidence: bare.commonDirEvidence,
    };
    await worktree.adoptBareRepository(selectedProjectId, bareRequest);
    assertCurrent(params.isCurrent);
    await ingestCurrentTargetSnapshot({
      catalog,
      worktree,
      targetId: params.targetId,
      isCurrent: params.isCurrent,
    });
    params.pendingRef.current = null;
    await params.refresh();
    return { status: "complete" };
  }

  const candidate = params.selection.candidate;
  if (
    candidate.targetId !== params.targetId ||
    candidate.bindingProjectMissing ||
    !pending.candidates.some((item) => candidateKey(item) === candidateKey(candidate))
  ) {
    throw new Error(
      candidate.bindingProjectMissing
        ? "project-sidebar-binding-project-missing"
        : "project-sidebar-stale-candidate",
    );
  }
  const selectedKey = candidateKey(candidate);
  if (pending.selectedCandidateKey && pending.selectedCandidateKey !== selectedKey) {
    throw new Error("project-sidebar-adoption-in-progress");
  }
  pending.selectedCandidateKey = selectedKey;
  params.pendingRef.current = pending;
  const selectedProjectId = await resolveProjectForAdoption({
    catalog,
    worktree,
    pending,
    candidate,
    isCurrent: params.isCurrent,
  });
  await ensureProjectForPending({ catalog, pending });
  assertCurrent(params.isCurrent);
  const adopted = pending.adoptedWorkspace
    ? { workspace: pending.adoptedWorkspace }
    : await worktree.adopt(selectedProjectId, worktreeCandidate(candidate));
  assertCurrent(params.isCurrent);
  pending.adoptedWorkspace = adopted.workspace;
  params.pendingRef.current = pending;
  const hadDefault = (await catalog.read()).projects.find(
    (project) => project.id === selectedProjectId,
  )?.defaultWorkspaceId;
  await ingestCurrentTargetSnapshot({
    catalog,
    worktree,
    targetId: params.targetId,
    isCurrent: params.isCurrent,
  });
  if (pending.createdProject && !hadDefault) {
    await maybeSetInitialDefault({
      catalog,
      projectId: selectedProjectId,
      targetId: params.targetId,
      workspaceId: adopted.workspace.id,
      createdProject: true,
    });
  }
  params.pendingRef.current = null;
  await params.refresh();
  return { status: "complete" };
}
