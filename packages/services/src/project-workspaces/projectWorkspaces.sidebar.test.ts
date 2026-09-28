import assert from "node:assert/strict";
import test from "node:test";
import { buildSidebarIndex, type SidebarIndexInput } from "./sidebarIndexService.js";
import type { AgentSessionRecord, Project, RepositoryBinding, WorktreeWorkspace } from "./planTypes.js";

function workspace(id: string, title: string): WorktreeWorkspace {
  return {
    schemaVersion: 1,
    id,
    projectId: "project-1",
    repositoryBindingId: "binding-1",
    title,
    worktreePath: `/work/${id}`,
    worktreeGeneration: `gen-${id}`,
    isMainWorktree: id === "main",
    head: { kind: "branch", ref: "develop", oid: "abc" },
    origin: "adopted",
    lifecycle: "active",
    verification: "verified",
  };
}

function session(id: string, workspaceId: string, title: string): AgentSessionRecord {
  return { schemaVersion: 1, id, workspaceId, harnessId: "pi", title };
}

function input(patch: Partial<SidebarIndexInput> = {}): SidebarIndexInput {
  const projects: Project[] = [{ schemaVersion: 1, id: "project-1", name: "Repo" }];
  const bindings: RepositoryBinding[] = [
    {
      schemaVersion: 1,
      id: "binding-1",
      projectId: "project-1",
      executionTargetId: "host-a",
      gitCommonDir: "/repo/.git",
    },
  ];
  const workspaces = [workspace("main", "主要"), workspace("linked", "功能")];
  const sessions = [
    session("s1", "main", "调研适配接口"),
    session("s2", "main", "实现会话管理"),
    session("s3", "main", "审阅当前变更"),
    session("s4", "linked", "另一个"),
  ];
  return {
    projects,
    bindings,
    workspaces,
    sessions,
    hiddenWorkspaceIds: [],
    archivedSessionIds: [],
    removedProjectIds: [],
    freshnessByTargetId: { "host-a": "live" },
    discoveredNotAdopted: 2,
    ...patch,
  };
}

test("侧栏同时保留待审批和运行计数，折叠与搜索不减少总数", () => {
  const index = buildSidebarIndex(
    input({
      activities: [
        { sessionId: "s1", activity: "waiting", pendingApproval: true, connection: "live" },
        { sessionId: "s2", activity: "running", connection: "offline", unread: true, lastTurn: "succeeded" },
        { sessionId: "s3", activity: "running", connection: "live" },
        { sessionId: "s4", activity: "idle", connection: "live" },
      ],
      collapsedWorkspaceIds: ["main"],
      query: "会话",
      hiddenWorkspaceIds: ["linked"],
    }),
  );
  const main = index.projects[0]?.workspaces.find((item) => item.id === "main");
  assert.equal(main?.agentTotal, 3);
  assert.equal(main?.agentMatched, 1);
  assert.equal(main?.counts.attention, 1);
  assert.equal(main?.counts.running, 2);
  assert.equal(main?.primary, "attention");
  assert.equal(main?.collapsed, true);
  assert.equal(main?.targetFreshness, "live");
  assert.equal(main?.sessionConnection, "offline");
  assert.equal(index.projects[0]?.attention, true);
  assert.equal(index.discoveredNotAdopted, 2);
  assert.equal(index.hiddenAdopted, 1);
  assert.equal("selectedSessionId" in index, false);
});

test("隐藏工作区的待审批仍进入项目 attention，扫描失败不把发现数变成 0", () => {
  const hidden = buildSidebarIndex(
    input({
      hiddenWorkspaceIds: ["linked"],
      activities: [{ sessionId: "s4", activity: "waiting", pendingApproval: true }],
      discoveredNotAdopted: null,
      freshnessByTargetId: { "host-a": "offline" },
    }),
  );
  assert.deepEqual(hidden.projects[0]?.attentionWorkspaceIds, ["linked"]);
  assert.equal(hidden.discoveredNotAdopted, null);
  assert.equal(hidden.projects[0]?.workspaces.find((item) => item.id === "linked")?.targetFreshness, "offline");
  assert.notEqual(hidden.projects[0]?.workspaces.find((item) => item.id === "linked")?.primary, "idle");
});

test("内部子会话和已归档会话不计入 N agents，50 个候选不需要历史正文", () => {
  const workspaces = Array.from({ length: 50 }, (_, index) => workspace(`wt-${index}`, `工作区${index}`));
  const sessions = Array.from({ length: 10 }, (_, index) => session(`agent-${index}`, "wt-0", `会话${index}`));
  const index = buildSidebarIndex(
    input({
      workspaces,
      sessions,
      discoveredNotAdopted: 50,
      archivedSessionIds: ["agent-0"],
      activities: [
        { sessionId: "agent-1", internalChild: true },
        { sessionId: "agent-2", activity: "idle" },
      ],
    }),
  );
  const row = index.projects[0]?.workspaces.find((item) => item.id === "wt-0");
  assert.equal(row?.agentTotal, 8);
  assert.equal(index.discoveredNotAdopted, 50);
  assert.equal(index.projects[0]?.workspaces.length, 50);
});
