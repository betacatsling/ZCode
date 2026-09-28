import type { ProjectCatalogProject } from "@zcode/services/project-catalog";
import type { SidebarBrowserFixtureState } from "./projectSidebarBrowserFixtureData.js";
import {
  createSessionRecord,
  currentCatalog,
  evidence,
  makeBinding,
  makeMigration,
  makeSummary,
  makeWorkspace,
} from "./projectSidebarBrowserFixtureData.js";

export function installHierarchyFixture(
  state: SidebarBrowserFixtureState,
  externalHostWorkspacePath?: string,
): void {
  const catalog = currentCatalog(state);
  let createdProject = catalog.projects.find((project) => project.id !== "other-scope-project");
  if (!createdProject) {
    createdProject = {
      schemaVersion: 1,
      id: "external-conversation-project",
      name: "External conversation fixture",
      workspaceIds: [],
      repositoryReferences: [],
      workspaceReferences: [],
      pinned: false,
      sortOrder: 0,
    };
    catalog.projects.push(createdProject);
  }
  state.firstProjectId = createdProject.id;
  const firstBindingId =
    state.worktrees.bindings.find((binding) => binding.projectId === createdProject.id)?.id ??
    "binding-fixture-one";
  const firstBinding = state.worktrees.bindings.find((binding) => binding.id === firstBindingId);
  if (!firstBinding) state.worktrees.bindings.push(makeBinding(createdProject.id, firstBindingId));
  let mainWorkspace = state.worktrees.workspaces.find((workspace) => workspace.id === "one-main");
  if (!mainWorkspace) {
    mainWorkspace = makeWorkspace({
      id: "one-main",
      projectId: createdProject.id,
      bindingId: firstBindingId,
      title: "Main checkout",
      path: "/fixture/repo",
      main: true,
      branch: "main",
    });
    state.worktrees.workspaces.push(mainWorkspace);
  }
  let adoptedWorkspace = state.worktrees.workspaces.find(
    (workspace) => workspace.projectId === createdProject.id && !workspace.isMainWorktree,
  );
  if (!adoptedWorkspace) {
    adoptedWorkspace = makeWorkspace({
      id: "one-linked",
      projectId: createdProject.id,
      bindingId: firstBindingId,
      title: "Feature UI",
      path: "/fixture/repo/feature-ui",
      branch: "feature/ui",
    });
    state.worktrees.workspaces.push(adoptedWorkspace);
  }
  const externalOwnerPath = externalHostWorkspacePath ?? adoptedWorkspace.worktreePath;
  state.externalHostWorkspacePath = externalOwnerPath;
  if (externalHostWorkspacePath) {
    adoptedWorkspace.worktreePath = externalOwnerPath;
    adoptedWorkspace.filesystemEvidence = evidence(externalOwnerPath);
  }
  adoptedWorkspace.id = "one-linked";
  adoptedWorkspace.title = "Feature UI";
  adoptedWorkspace.head = { kind: "branch", ref: "feature/ui", oid: null };
  createdProject.workspaceIds = [];

  const projectTwo: ProjectCatalogProject = {
    schemaVersion: 1,
    id: "project-two",
    name: "Second Project",
    workspaceIds: [],
    repositoryReferences: [],
    workspaceReferences: [],
    pinned: false,
    sortOrder: 1,
  };
  if (!catalog.projects.some((project) => project.id === projectTwo.id))
    catalog.projects.push(projectTwo);
  const secondBindingId = "binding-two";
  if (!state.worktrees.bindings.some((binding) => binding.id === secondBindingId)) {
    state.worktrees.bindings.push(
      makeBinding(projectTwo.id, secondBindingId, "/fixture/repo-two/.git"),
    );
  }
  if (!state.worktrees.workspaces.some((workspace) => workspace.id === "two-main")) {
    state.worktrees.workspaces.push(
      makeWorkspace({
        id: "two-main",
        projectId: projectTwo.id,
        bindingId: secondBindingId,
        title: "Second main",
        path: "/fixture/repo-two",
        main: true,
        branch: "trunk",
      }),
      makeWorkspace({
        id: "two-detached",
        projectId: projectTwo.id,
        bindingId: secondBindingId,
        title: "Detached experiment",
        path: "/fixture/repo-two/detached",
        detached: "abc123def456",
      }),
    );
  }
  const twoDetached = state.worktrees.workspaces.find(
    (workspace) => workspace.id === "two-detached",
  )!;
  const twoMain = state.worktrees.workspaces.find((workspace) => workspace.id === "two-main")!;
  const native = createSessionRecord({
    hierarchySessionId: "native-session",
    projectId: createdProject.id,
    workspaceId: adoptedWorkspace.id,
    workspacePath: adoptedWorkspace.worktreePath,
    harnessId: "zcode",
    ownerKind: "native-v4",
  });
  const firstPi = createSessionRecord({
    hierarchySessionId: "pi-review",
    projectId: createdProject.id,
    workspaceId: adoptedWorkspace.id,
    workspacePath: externalOwnerPath,
    harnessId: "pi",
    ownerKind: "agent-host",
  });
  const secondPi = createSessionRecord({
    hierarchySessionId: "pi-idle",
    projectId: createdProject.id,
    workspaceId: adoptedWorkspace.id,
    workspacePath: externalOwnerPath,
    harnessId: "pi",
    ownerKind: "agent-host",
  });
  const secondProjectPi = createSessionRecord({
    hierarchySessionId: "pi-detached",
    projectId: projectTwo.id,
    workspaceId: twoDetached.id,
    workspacePath: externalOwnerPath,
    harnessId: "pi",
    ownerKind: "agent-host",
  });
  const pendingNonGitRecord = {
    hierarchySessionId: "legacy-non-git-session",
    nativeSessionId: "legacy-non-git-session",
    ownerKind: "native-v4" as const,
    targetId: "fixture-target",
    workspacePath: "/fixture/non-git-history",
    status: "pending-verification" as const,
    pendingReason: "nonGit" as const,
  };
  const _otherMainEmpty = twoMain;
  state.migration = makeMigration([native, firstPi, secondPi, secondProjectPi, pendingNonGitRecord]);
  state.tasks = [
    {
      taskId: "native-session",
      traceId: "fixture-trace",
      title: "Native task: preserve subdirectory",
      workspacePath: adoptedWorkspace.worktreePath,
      createdAt: 1_780_000_000_000,
      updatedAt: 1_780_000_456_000,
      mode: "code",
    } as unknown as ZCodeTaskMeta,
    {
      taskId: "legacy-only-task",
      traceId: "legacy-fixture-trace",
      title: "Legacy-only task history",
      workspacePath: adoptedWorkspace.worktreePath,
      createdAt: 1_780_000_000_000,
      updatedAt: 1_780_000_456_000,
      mode: "code",
    } as unknown as ZCodeTaskMeta,
  ];
  state.summaries = [
    makeSummary({
      sessionId: "pi-review",
      workspacePath: externalOwnerPath,
      title: "Review the project hierarchy",
      status: "waiting",
      pendingInteractionCount: 1,
      updatedAt: 1_780_000_789_000,
    }),
    makeSummary({
      sessionId: "pi-idle",
      workspacePath: externalOwnerPath,
      title: "Second Pi session",
      status: "idle",
      updatedAt: 1_780_000_654_000,
    }),
    makeSummary({
      sessionId: "pi-detached",
      workspacePath: externalOwnerPath,
      title: "Detached Pi session",
      status: "waiting",
      pendingInteractionCount: 1,
      updatedAt: 1_780_000_321_000,
    }),
  ];
}
