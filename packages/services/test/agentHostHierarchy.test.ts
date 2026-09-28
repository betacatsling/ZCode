import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveExecutionSnapshot,
  hierarchySnapshotSchema,
  parseHierarchySnapshot,
  resolveSessionOwnership,
  type AgentSession,
  type HierarchySnapshot,
} from "@zcode/shared/agent-host";

function hierarchyFixture(): HierarchySnapshot {
  return parseHierarchySnapshot({
    schemaVersion: 1,
    projects: [
      {
        schemaVersion: 1,
        id: "project-one",
        name: "Project One",
        defaultWorkspaceId: "workspace-linked",
        defaultWorkspaceTargetId: "target-local",
      },
      {
        schemaVersion: 1,
        id: "project-two",
        name: "Project Two",
        defaultWorkspaceId: "workspace-remote",
        defaultWorkspaceTargetId: "target-remote",
      },
    ],
    bindings: [
      {
        schemaVersion: 1,
        id: "binding-local",
        projectId: "project-one",
        executionTargetId: "target-local",
        gitCommonDir: "/repo/.git",
      },
      {
        schemaVersion: 1,
        id: "binding-remote",
        projectId: "project-two",
        executionTargetId: "target-remote",
        // The same path is valid on separate targets and is not a global identity.
        gitCommonDir: "/repo/.git",
      },
    ],
    workspaces: [
      {
        schemaVersion: 1,
        id: "workspace-main",
        projectId: "project-one",
        repositoryBindingId: "binding-local",
        title: "Main",
        workspaceIdentity: "   ",
        worktreePath: "/repo",
        worktreeGeneration: "generation-main",
        isMainWorktree: true,
        head: { kind: "branch", ref: "main", oid: null },
        origin: "adopted",
        lifecycle: "active",
        verification: "verified",
      },
      {
        schemaVersion: 1,
        id: "workspace-linked",
        projectId: "project-one",
        repositoryBindingId: "binding-local",
        title: "Feature",
        workspaceIdentity: "  existing-workspace-identity  ",
        worktreePath: "/repo-feature",
        worktreeGeneration: "generation-feature",
        isMainWorktree: false,
        head: { kind: "branch", ref: "feature", oid: "abc123" },
        origin: "adopted",
        lifecycle: "active",
        verification: "verified",
      },
      {
        schemaVersion: 1,
        id: "workspace-remote",
        projectId: "project-two",
        repositoryBindingId: "binding-remote",
        title: "Remote Main",
        workspaceIdentity: "existing-remote-identity",
        worktreePath: "/repo",
        worktreeGeneration: "generation-remote",
        isMainWorktree: true,
        head: { kind: "detached", oid: "def456" },
        origin: "adopted",
        lifecycle: "active",
        verification: "verified",
      },
    ],
    sessions: [
      {
        schemaVersion: 1,
        id: "session-pi-one",
        workspaceId: "workspace-main",
        harnessId: "pi",
        title: "Research",
        modelBinding: {
          kind: "host-managed",
          selection: { providerId: "provider-a", modelId: "model-a" },
        },
      },
      {
        schemaVersion: 1,
        id: "session-pi-two",
        workspaceId: "workspace-main",
        harnessId: "pi",
        title: "Implementation",
      },
      {
        schemaVersion: 1,
        id: "session-zcode",
        workspaceId: "workspace-linked",
        harnessId: "zcode",
        title: "Review",
      },
      {
        schemaVersion: 1,
        id: "session-remote",
        workspaceId: "workspace-remote",
        harnessId: "pi",
        title: "Remote",
      },
    ],
  });
}

test("hierarchy keeps main and linked worktrees distinct while allowing repeated harness sessions", () => {
  const snapshot = hierarchyFixture();
  const ownership = resolveSessionOwnership(snapshot, " session-pi-one ");

  assert.equal(ownership.project.id, "project-one");
  assert.equal(ownership.binding.id, "binding-local");
  assert.equal(ownership.workspace.isMainWorktree, true);
  assert.deepEqual(
    snapshot.sessions
      .filter((session) => session.workspaceId === "workspace-main")
      .map((session) => session.harnessId),
    ["pi", "pi"],
  );
  assert.equal(snapshot.projects[0]?.defaultWorkspaceId, "workspace-linked");
  assert.equal(snapshot.workspaces[0]?.isMainWorktree, true);
  assert.equal(snapshot.projects[0]?.defaultWorkspaceId === snapshot.workspaces[0]?.id, false);
  assert.throws(() => resolveSessionOwnership(snapshot, "missing-session"), /unknown-session/);
  assert.throws(() => resolveSessionOwnership(snapshot, "   "), /too_small|Too small/i);
});

test("same path on another target remains a separate workspace and derives its target", () => {
  const snapshot = hierarchyFixture();
  const local = resolveSessionOwnership(snapshot, "session-pi-one");
  const remote = resolveSessionOwnership(snapshot, "session-remote");
  const localExecution = deriveExecutionSnapshot({
    project: local.project,
    binding: local.binding,
    workspace: local.workspace,
    session: local.session,
  });
  const remoteExecution = deriveExecutionSnapshot({
    project: remote.project,
    binding: remote.binding,
    workspace: remote.workspace,
    session: remote.session,
  });

  assert.equal(localExecution.execution.worktreePath, remoteExecution.execution.worktreePath);
  assert.equal(localExecution.execution.targetId, "target-local");
  assert.equal(remoteExecution.execution.targetId, "target-remote");
  assert.notEqual(localExecution.workspaceId, remoteExecution.workspaceId);
  assert.notEqual(
    localExecution.execution.worktreeGeneration,
    remoteExecution.execution.worktreeGeneration,
  );
});

test("cross-record ownership, duplicate IDs and strict versions are rejected", () => {
  const snapshot = hierarchyFixture();
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        projects: [...snapshot.projects, snapshot.projects[0]],
      }),
    /duplicate-id/,
  );
  assert.equal(
    hierarchySnapshotSchema.safeParse({
      ...snapshot,
      sessions: [...snapshot.sessions, snapshot.sessions[0]],
    }).success,
    false,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        bindings: [...snapshot.bindings, snapshot.bindings[0]],
      }),
    /duplicate-id/,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        workspaces: [...snapshot.workspaces, snapshot.workspaces[0]],
      }),
    /duplicate-id/,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        sessions: [...snapshot.sessions, snapshot.sessions[0]],
      }),
    /duplicate-id/,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        projects: [
          { ...snapshot.projects[0], defaultWorkspaceId: "workspace-remote" },
          snapshot.projects[1],
        ],
      }),
    /default-workspace|ownership/,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        projects: [
          { ...snapshot.projects[0], defaultWorkspaceTargetId: "target-remote" },
          snapshot.projects[1],
        ],
      }),
    /default-workspace/,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        workspaces: [
          { ...snapshot.workspaces[0], repositoryBindingId: "binding-remote" },
          ...snapshot.workspaces.slice(1),
        ],
      }),
    /ownership/,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        bindings: [{ ...snapshot.bindings[0], projectId: "missing-project" }, snapshot.bindings[1]],
      }),
    /ownership/,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        sessions: [
          { ...snapshot.sessions[0], workspaceId: "missing-workspace" },
          ...snapshot.sessions.slice(1),
        ],
      }),
    /ownership/,
  );
  assert.throws(
    () => parseHierarchySnapshot({ ...snapshot, schemaVersion: 2 }),
    /Invalid|expected|version/i,
  );
  assert.throws(
    () =>
      parseHierarchySnapshot({
        ...snapshot,
        workspaces: snapshot.workspaces.map(
          ({ verification: _verification, ...workspace }) => workspace,
        ),
      }),
    /verification/,
  );
});

test("inactive or unverified workspaces cannot derive a new execution context", () => {
  const snapshot = hierarchyFixture();
  const ownership = resolveSessionOwnership(snapshot, "session-pi-one");
  for (const workspace of [
    { ...ownership.workspace, lifecycle: "archived" as const },
    { ...ownership.workspace, verification: "needsVerification" as const },
  ]) {
    assert.throws(
      () => deriveExecutionSnapshot({ ...ownership, workspace }),
      /workspace-not-admissible/,
    );
  }
});

test("execution identity is derived from trusted binding/workspace and session cannot override it", () => {
  const snapshot = hierarchyFixture();
  const ownership = resolveSessionOwnership(snapshot, "session-pi-one");
  const session = ownership.session as AgentSession & { execution?: unknown };
  session.execution = {
    targetId: "attacker-target",
    workspaceIdentity: "attacker-workspace",
    worktreeGeneration: "attacker-generation",
  };
  assert.throws(
    () => deriveExecutionSnapshot({ ...ownership, session }),
    /Unrecognized key|execution|session-input/i,
  );
  const cleanOwnership = resolveSessionOwnership(snapshot, "session-pi-one");
  assert.throws(
    () =>
      deriveExecutionSnapshot({
        ...cleanOwnership,
        binding: hierarchyFixture().bindings[1]!,
      }),
    /ownership/,
  );

  const parsed = resolveSessionOwnership(snapshot, "session-pi-one");
  const derived = deriveExecutionSnapshot({
    ...parsed,
    cwdRelativeToWorktree: "src/lib",
  });
  assert.equal(derived.execution.targetId, "target-local");
  assert.equal(derived.execution.workspaceIdentity, "/repo");
  assert.equal(derived.execution.worktreeGeneration, "generation-main");
  assert.equal(derived.execution.cwdRelativeToWorktree, "src/lib");
  assert.throws(
    () => deriveExecutionSnapshot({ ...parsed, cwdRelativeToWorktree: "../outside" }),
    /cwd/,
  );
  assert.throws(() => deriveExecutionSnapshot({ ...parsed, cwdRelativeToWorktree: "a\\b" }), /cwd/);
  const trimmedIdentity = deriveExecutionSnapshot({
    ...resolveSessionOwnership(snapshot, "session-zcode"),
  });
  assert.equal(trimmedIdentity.execution.workspaceIdentity, "existing-workspace-identity");
});

test("derived model binding is independent from the session input", () => {
  const snapshot = hierarchyFixture();
  const ownership = resolveSessionOwnership(snapshot, "session-pi-one");
  const derived = deriveExecutionSnapshot(ownership);
  const session = ownership.session as AgentSession;
  if (
    session.modelBinding?.kind !== "host-managed" ||
    derived.modelBinding?.kind !== "host-managed"
  ) {
    assert.fail("fixture must contain a host-managed model binding");
  }
  session.modelBinding.selection.providerId = "mutated-after-derive";
  assert.equal(derived.modelBinding.selection.providerId, "provider-a");
});
