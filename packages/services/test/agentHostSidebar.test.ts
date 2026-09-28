import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHierarchySnapshot,
  type SidebarSessionRuntimeSummary,
} from "@zcode/shared/agent-host";
import { projectSidebarSnapshot } from "../src/agent-ui-projection/sidebarProjector.js";
import type { HarnessDirectory } from "../src/agent-host/harnessDirectory.js";

function hierarchyFixture() {
  return parseHierarchySnapshot({
    schemaVersion: 1,
    projects: [
      { schemaVersion: 1, id: "project-one", name: "One", iconAssetId: "project-one" },
      { schemaVersion: 1, id: "project-two", name: "Two", defaultWorkspaceId: "workspace-four" },
    ],
    bindings: [
      {
        schemaVersion: 1,
        id: "binding-one",
        projectId: "project-one",
        executionTargetId: "target-one",
        gitCommonDir: "/one/.git",
      },
      {
        schemaVersion: 1,
        id: "binding-two",
        projectId: "project-two",
        executionTargetId: "target-two",
        gitCommonDir: "/two/.git",
      },
    ],
    workspaces: [
      {
        schemaVersion: 1,
        id: "workspace-one",
        projectId: "project-one",
        repositoryBindingId: "binding-one",
        title: "One Main",
        worktreePath: "/one",
        worktreeGeneration: "one-main",
        isMainWorktree: true,
        head: { kind: "branch", ref: "main", oid: null },
        origin: "adopted",
        lifecycle: "active",
        verification: "verified",
      },
      {
        schemaVersion: 1,
        id: "workspace-two",
        projectId: "project-one",
        repositoryBindingId: "binding-one",
        title: "One Feature",
        worktreePath: "/one-feature",
        worktreeGeneration: "one-feature",
        isMainWorktree: false,
        head: { kind: "branch", ref: "feature", oid: "abc" },
        origin: "created",
        lifecycle: "active",
        verification: "verified",
      },
      {
        schemaVersion: 1,
        id: "workspace-three",
        projectId: "project-two",
        repositoryBindingId: "binding-two",
        title: "Two Main",
        worktreePath: "/two",
        worktreeGeneration: "two-main",
        isMainWorktree: true,
        head: { kind: "detached", oid: "def" },
        origin: "adopted",
        lifecycle: "active",
        verification: "verified",
      },
      {
        schemaVersion: 1,
        id: "workspace-four",
        projectId: "project-two",
        repositoryBindingId: "binding-two",
        title: "Two Feature",
        worktreePath: "/two-feature",
        worktreeGeneration: "two-feature",
        isMainWorktree: false,
        head: { kind: "branch", ref: "feature", oid: "ghi" },
        origin: "created",
        lifecycle: "active",
        verification: "verified",
      },
    ],
    sessions: [
      {
        schemaVersion: 1,
        id: "pi-running",
        workspaceId: "workspace-one",
        harnessId: "pi",
        title: "Running",
      },
      {
        schemaVersion: 1,
        id: "pi-pending",
        workspaceId: "workspace-one",
        harnessId: "pi",
        title: "Pending",
      },
      {
        schemaVersion: 1,
        id: "terminal-row",
        workspaceId: "workspace-one",
        harnessId: "zcode",
        title: "Terminal",
      },
      {
        schemaVersion: 1,
        id: "unknown-row",
        workspaceId: "workspace-three",
        harnessId: "unknown",
        title: "Unknown",
      },
    ],
  });
}

const directory = {
  get(id: string) {
    if (id === "pi") {
      return {
        status: "registered" as const,
        capabilitiesDeclared: false,
        manifest: {
          schemaVersion: 1 as const,
          id: "pi",
          name: "Pi",
          adapterVersion: "0.87.1",
          icon: { lightAssetId: "pi-light" },
        },
      };
    }
    return undefined;
  },
  list() {
    return [];
  },
} satisfies HarnessDirectory;

function summary(
  input: Partial<SidebarSessionRuntimeSummary> &
    Pick<SidebarSessionRuntimeSummary, "sessionId" | "workspaceId">,
): SidebarSessionRuntimeSummary {
  return {
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    activity: "idle",
    freshness: "live",
    recentOutcome: "success",
    unread: false,
    pendingInteractionCount: 0,
    updatedAt: 1,
    archived: false,
    kind: "top-level",
    ...input,
  };
}

test("sidebar keeps empty nodes, two Pi sessions, separate lifecycle fields, and full counts", () => {
  const snapshot = projectSidebarSnapshot({
    hierarchy: hierarchyFixture(),
    summaries: [
      summary({
        sessionId: "pi-running",
        workspaceId: "workspace-one",
        activity: "running",
        recentOutcome: "none",
      }),
      summary({
        sessionId: "pi-pending",
        workspaceId: "workspace-one",
        activity: "waiting",
        pendingInteractionCount: 1,
      }),
      summary({
        sessionId: "terminal-row",
        workspaceId: "workspace-one",
        kind: "terminal",
        freshness: "offline",
        recentOutcome: "success",
      }),
      summary({
        sessionId: "unknown-row",
        workspaceId: "workspace-three",
        freshness: "offline",
        recentOutcome: "unknown",
        unread: true,
      }),
    ],
    directory,
    appearance: "light",
  });

  assert.equal(snapshot.projects.length, 2);
  assert.equal(snapshot.projects[0]?.workspaces.length, 2);
  assert.equal(snapshot.projects[1]?.workspaces.length, 2);
  const workspaceOne = snapshot.projects[0]!.workspaces[0]!;
  assert.equal(workspaceOne.sessions.length, 3);
  assert.deepEqual(
    workspaceOne.sessions.filter((row) => row.harnessId === "pi").map((row) => row.title),
    ["Running", "Pending"],
  );
  assert.equal(workspaceOne.sessions[0]?.recentOutcome, "none");
  assert.equal(workspaceOne.summary.agentCount, 2);
  assert.equal(workspaceOne.summary.sessionCount, 3);
  assert.equal(workspaceOne.summary.pendingInteractionCount, 1);
  assert.equal(workspaceOne.summary.runningCount, 2);
  assert.equal(workspaceOne.summary.unknownCount, 0);
  assert.equal(workspaceOne.summary.attention, "pending");
  assert.equal(workspaceOne.sessions[0]?.icon.kind, "asset");
  assert.equal(workspaceOne.sessions[2]?.freshness, "offline");
  assert.equal(workspaceOne.sessions[2]?.recentOutcome, "success");
  assert.equal(workspaceOne.sessions[2]?.directoryStatus, "unknown");
  assert.equal(workspaceOne.head.kind, "branch");
  assert.equal(workspaceOne.targetFreshness, "unknown");
  assert.equal(snapshot.projects[0]?.summary.agentCount, 2);
  assert.equal(snapshot.projects[0]?.summary.pendingInteractionCount, 1);
  assert.equal(snapshot.projects[1]?.workspaces[1]?.sessions.length, 0);
});

test("sidebar excludes archived/internal summaries from agent counts and never invents unknown completion", () => {
  const hierarchy = hierarchyFixture();
  const snapshot = projectSidebarSnapshot({
    hierarchy,
    summaries: [
      summary({
        sessionId: "pi-running",
        workspaceId: "workspace-one",
        archived: true,
        activity: "idle",
      }),
      summary({
        sessionId: "pi-pending",
        workspaceId: "workspace-one",
        kind: "internal",
        activity: "running",
      }),
      summary({
        sessionId: "terminal-row",
        workspaceId: "workspace-one",
        kind: "terminal",
        recentOutcome: "failed",
      }),
    ],
    directory,
    appearance: "dark",
  });
  const workspaceOne = snapshot.projects[0]!.workspaces[0]!;
  assert.equal(workspaceOne.summary.agentCount, 0);
  assert.equal(workspaceOne.summary.sessionCount, 3);
  assert.equal(workspaceOne.summary.unknownCount, 0);
  const unknown = snapshot.projects[1]!.workspaces[0]!.sessions[0]!;
  assert.equal(unknown.activity, "unknown");
  // 该 session 缺少 summary，不能据此断言它从未有过 turn。
  assert.equal(unknown.recentOutcome, "unknown");
  assert.equal(unknown.attention, "unknown");
  assert.equal(unknown.icon.kind, "fallback");
  assert.equal(unknown.harnessName, "unknown");
});

test("sidebar keeps a failed outcome visible alongside current activity and target freshness", () => {
  const snapshot = projectSidebarSnapshot({
    hierarchy: hierarchyFixture(),
    summaries: [
      summary({
        sessionId: "pi-running",
        workspaceId: "workspace-one",
        activity: "running",
        recentOutcome: "failed",
      }),
      summary({
        sessionId: "pi-pending",
        workspaceId: "workspace-one",
        activity: "waiting",
        pendingInteractionCount: 1,
      }),
    ],
    targetFreshness: new Map([["target-one", "offline"]]),
    directory,
    appearance: "light",
  });
  const workspaceOne = snapshot.projects[0]!.workspaces[0]!;
  assert.equal(workspaceOne.summary.runningCount, 2);
  assert.equal(workspaceOne.summary.errorCount, 1);
  assert.equal(workspaceOne.summary.pendingInteractionCount, 1);
  assert.equal(workspaceOne.summary.attention, "pending");
  assert.equal(workspaceOne.targetFreshness, "offline");
  assert.equal(snapshot.projects[0]!.workspaces[1]!.sessions.length, 0);
  assert.equal(snapshot.projects[0]!.workspaces[1]!.targetFreshness, "offline");
});

test("sidebar rejects duplicate or cross-workspace runtime summaries", () => {
  const hierarchy = hierarchyFixture();
  const first = summary({ sessionId: "pi-running", workspaceId: "workspace-one" });
  assert.throws(
    () =>
      projectSidebarSnapshot({
        hierarchy,
        summaries: [first, first],
        directory,
        appearance: "light",
      }),
    /duplicate sidebar summary/,
  );
  assert.throws(
    () =>
      projectSidebarSnapshot({
        hierarchy,
        summaries: [summary({ sessionId: "pi-running", workspaceId: "workspace-two" })],
        directory,
        appearance: "light",
      }),
    /workspace mismatch/,
  );
});

test("sidebar ignores stale summaries that are not hierarchy members", () => {
  const snapshot = projectSidebarSnapshot({
    hierarchy: hierarchyFixture(),
    summaries: [summary({ sessionId: "stale", workspaceId: "workspace-one", activity: "running" })],
    directory,
    appearance: "light",
  });
  assert.equal(snapshot.projects[0]?.workspaces[0]?.sessions.length, 3);
  assert.equal(snapshot.projects[0]?.summary.runningCount, 0);
});
