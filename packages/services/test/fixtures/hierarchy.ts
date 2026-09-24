import { parseSidebarSnapshot } from "@zcode/shared/project-workspaces";

export const hierarchyFixture = parseSidebarSnapshot({
  schemaVersion: 1,
  projects: [
    { schemaVersion: 1, id: "p1", name: "Project One", defaultWorkspaceId: "w1" },
    { schemaVersion: 1, id: "p2", name: "Project Two", defaultWorkspaceId: "w3" },
  ],
  bindings: [
    {
      schemaVersion: 1,
      id: "b1",
      projectId: "p1",
      executionTargetId: "local",
      gitCommonDir: "/repo/.git",
    },
    {
      schemaVersion: 1,
      id: "b2",
      projectId: "p2",
      executionTargetId: "ssh-a",
      gitCommonDir: "/repo/.git",
    },
  ],
  workspaces: [
    {
      id: "w1",
      projectId: "p1",
      repositoryBindingId: "b1",
      title: "Main",
      workspaceIdentity: "local-main",
      worktreePath: "/repo",
      isMainWorktree: true,
    },
    {
      id: "w2",
      projectId: "p1",
      repositoryBindingId: "b1",
      title: "Feature",
      workspaceIdentity: "local-feature",
      worktreePath: "/feature",
      isMainWorktree: false,
    },
    {
      id: "w3",
      projectId: "p2",
      repositoryBindingId: "b2",
      title: "Remote Main",
      workspaceIdentity: "ssh-main",
      worktreePath: "/repo",
      isMainWorktree: true,
    },
    {
      id: "w4",
      projectId: "p2",
      repositoryBindingId: "b2",
      title: "Remote Feature",
      workspaceIdentity: "ssh-feature",
      worktreePath: "/feature",
      isMainWorktree: false,
    },
  ].map((workspace) => ({
    schemaVersion: 1,
    worktreeGeneration: `generation-${workspace.id}`,
    head: { kind: "branch", ref: "main", oid: null },
    origin: "adopted",
    lifecycle: "active",
    ...workspace,
  })),
  sessions: [
    { id: "s1", projectId: "p1", workspaceId: "w1", harnessId: "pi", title: "Research" },
    { id: "s2", projectId: "p1", workspaceId: "w1", harnessId: "pi", title: "Implementation" },
    { id: "s3", projectId: "p1", workspaceId: "w1", harnessId: "zcode", title: "Review" },
  ].map((session, index) => ({
    session: { schemaVersion: 1, archived: false, ...session },
    updatedAt: index + 1,
    activity: "idle",
    freshness: "live",
    unread: false,
  })),
});
