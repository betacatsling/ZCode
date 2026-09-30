import assert from "node:assert/strict";
import test from "node:test";
import { createProjectWorkspaces } from "./index.js";
import { createMemoryCatalogStore } from "./store.js";
import { assertCode, createWorkspaceWorld } from "./projectWorkspaces.test-support.js";

function linkedWorld() {
  const world = createWorkspaceWorld({
    "/repo": { device: 1, inode: 1 },
    "/repo/.git": { device: 1, inode: 2 },
    "/repo-a": { device: 1, inode: 3 },
    "/repo-b": { device: 1, inode: 4 },
  });
  world.records.push(
    { path: "/repo", oid: "aaa111", branch: "develop" },
    { path: "/repo-a", oid: "bbb222", branch: "main" },
    { path: "/repo-b", oid: "ccc333", branch: "feature/other" },
  );
  return world;
}

function runtimeFor(
  world: ReturnType<typeof linkedWorld>,
  executionTargetId: string,
  store = createMemoryCatalogStore(),
  idFactory?: () => string,
) {
  return createProjectWorkspaces({
    executionTargetId,
    git: world.git,
    filesystem: world.filesystem,
    activity: world.activityPort,
    store,
    idFactory: idFactory ?? world.idFactory,
    knownHarnessIds: ["pi", "codex"],
  });
}

test("删除进行中拒绝新会话，失败时不删目录也不停会话", async () => {
  const world = linkedWorld();
  const runtime = runtimeFor(world, "host-a");
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const session = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "保留",
  });
  const started = world.holdRemove();
  const removal = runtime.worktrees.removeLinkedWorktree({
    workspaceId: adopted.workspace.id,
    expectedGeneration: adopted.workspace.worktreeGeneration,
    acknowledgeRisks: true,
    acknowledgeExternalWriters: true,
    stopConfirmed: false,
  });
  await started;
  await assert.rejects(
    runtime.worktrees.createAgentSession({
      workspaceId: adopted.workspace.id,
      harnessId: "codex",
      title: "删除中",
    }),
    (error) => assertCode(error, "deletion-admission-rejected"),
  );
  assert.equal(await world.filesystem.exists("/repo-a"), true);
  assert.equal(
    world.records.some((record) => record.path === "/repo-a"),
    true,
  );
  assert.equal(world.stopped.length, 0);
  assert.equal(
    (await runtime.worktrees.listSessions(adopted.workspace.id))[0]?.id,
    session.session.id,
  );
  world.releaseRemove();
  const removed = await removal;
  assert.equal(removed.status, "removed");

  const other = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-b" });
  assert.equal(other.status, "adopted");
  if (other.status !== "adopted") return;
  world.setFailRemove(true);
  const failed = await runtime.worktrees.removeLinkedWorktree({
    workspaceId: other.workspace.id,
    expectedGeneration: other.workspace.worktreeGeneration,
    acknowledgeRisks: true,
    acknowledgeExternalWriters: true,
    stopConfirmed: false,
  });
  assert.equal(failed.status, "rejected");
  if (failed.status === "rejected")
    assert.equal(failed.reasons.includes("git-remove-failed"), true);
  assert.equal(await world.filesystem.exists("/repo-b"), true);
  assert.equal(
    world.records.some((record) => record.path === "/repo-b"),
    true,
  );
  assert.equal(world.stopped.length, 0);
  const admitted = await runtime.worktrees.createAgentSession({
    workspaceId: other.workspace.id,
    harnessId: "pi",
    title: "栅栏已撤",
  });
  assert.equal(admitted.execution.admissible, true);
});

test("目录消失后重建不能串到另一台主机的同路径", async () => {
  const store = createMemoryCatalogStore();
  let nextId = 0;
  const idFactory = () => `safe-${++nextId}`;
  const hostA = linkedWorld();
  const runtimeA = runtimeFor(hostA, "host-a", store, idFactory);
  const project = await runtimeA.catalog.createProject({ name: "Repo" });
  const main = await runtimeA.worktrees.adopt({ projectId: project.id, worktreePath: "/repo" });
  const adopted = await runtimeA.worktrees.adopt({
    projectId: project.id,
    worktreePath: "/repo-a",
  });
  assert.equal(main.status, "adopted");
  assert.equal(adopted.status, "adopted");
  if (main.status !== "adopted" || adopted.status !== "adopted") return;
  const session = await runtimeA.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "旧历史",
  });
  await runtimeA.worktrees.noteSessionActivities([
    { sessionId: session.session.id, activity: "running", connection: "live", lastTurn: "unknown" },
  ]);

  delete hostA.entries["/repo-a"];
  hostA.records.splice(
    hostA.records.findIndex((record) => record.path === "/repo-a"),
    1,
  );
  const missing = await runtimeA.reconciler.refresh("/repo-a");
  assert.equal(missing.missingIds.includes(adopted.workspace.id), true);
  assert.equal(missing.unadoptedCount, null);
  const afterMissing = await store.read();
  assert.equal(
    afterMissing.workspaces.find((item) => item.id === adopted.workspace.id)?.lifecycle,
    "missing",
  );
  assert.equal(
    afterMissing.workspaces.find((item) => item.id === main.workspace.id)?.lifecycle,
    "active",
  );
  assert.equal(afterMissing.stoppedSessionIds.includes(session.session.id), false);
  assert.equal(afterMissing.sessionActivityById[session.session.id]?.activity, "running");
  assert.notEqual(afterMissing.sessionActivityById[session.session.id]?.lastTurn, "succeeded");

  const hostB = createWorkspaceWorld({
    "/repo": { device: 7, inode: 1 },
    "/repo/.git": { device: 7, inode: 2 },
    "/repo-a": { device: 7, inode: 90 },
  });
  hostB.records.push({ path: "/repo-a", oid: "fff999", branch: "rebuilt" });
  const runtimeB = runtimeFor(hostB, "host-b", store, idFactory);
  const rebuilt = await runtimeB.worktrees.adopt({
    projectId: project.id,
    worktreePath: "/repo-a",
    title: "另一台",
  });
  assert.equal(rebuilt.status, "adopted");
  if (rebuilt.status !== "adopted") return;
  assert.notEqual(rebuilt.workspace.id, adopted.workspace.id);
  assert.notEqual(rebuilt.binding.id, adopted.binding.id);
  assert.equal(rebuilt.binding.executionTargetId, "host-b");
  assert.equal(rebuilt.binding.gitCommonDir, adopted.binding.gitCommonDir);
  assert.equal((await runtimeB.worktrees.listSessions(rebuilt.workspace.id)).length, 0);
  await runtimeB.reconciler.refresh("/repo-a");
  const stillMissing = (await store.read()).workspaces.find(
    (item) => item.id === adopted.workspace.id,
  );
  assert.equal(stillMissing?.lifecycle, "missing");
  assert.equal(
    (await runtimeA.worktrees.readExecution(session.session.id)).workspaceId,
    adopted.workspace.id,
  );
  assert.equal((await runtimeA.worktrees.readExecution(session.session.id)).admissible, false);

  hostA.entries["/repo-a"] = { device: 1, inode: 80 };
  hostA.records.push({ path: "/repo-a", oid: "fff999", branch: "rebuilt" });
  const again = await runtimeA.reconciler.refresh("/repo-a");
  assert.equal(again.needsVerificationIds.includes(adopted.workspace.id), true);
  assert.equal(
    (await store.read()).workspaces.find((item) => item.id === adopted.workspace.id)?.lifecycle,
    "missing",
  );
  await assert.rejects(
    runtimeA.worktrees.createAgentSession({
      workspaceId: adopted.workspace.id,
      harnessId: "pi",
      title: "不能进新目录",
    }),
    (error) => assertCode(error, "workspace-missing"),
  );
  const localRebuild = await runtimeA.worktrees.adopt({
    projectId: project.id,
    worktreePath: "/repo-a",
    title: "本机重建",
  });
  assert.equal(localRebuild.status, "adopted");
  if (localRebuild.status !== "adopted") return;
  assert.notEqual(localRebuild.workspace.id, adopted.workspace.id);
  assert.notEqual(localRebuild.workspace.id, rebuilt.workspace.id);
  const execution = await runtimeA.worktrees.readExecution(session.session.id);
  assert.equal(execution.workspaceId, adopted.workspace.id);
  assert.equal(execution.executionTargetId, "host-a");
  assert.equal((await runtimeB.worktrees.listSessions(rebuilt.workspace.id)).length, 0);
  const otherSession = await runtimeB.worktrees.createAgentSession({
    workspaceId: rebuilt.workspace.id,
    harnessId: "codex",
    title: "新主机",
  });
  assert.notEqual(otherSession.session.id, session.session.id);
  assert.equal(otherSession.execution.executionTargetId, "host-b");
});

test("离线重扫描保留工作区树和过期摘要，不把 Agent 标成已停止或已完成", async () => {
  const world = linkedWorld();
  const runtime = runtimeFor(world, "host-a");
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const running = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "运行中",
  });
  const waiting = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "待审批",
  });
  const live = await runtime.reconciler.refresh("/repo-a");
  assert.equal(live.freshness, "live");
  assert.equal(live.unadoptedCount, 2);
  await runtime.worktrees.noteSessionActivities([
    { sessionId: running.session.id, activity: "running", connection: "live", lastTurn: "unknown" },
    {
      sessionId: waiting.session.id,
      activity: "waiting",
      pendingApproval: true,
      connection: "live",
      lastTurn: "unknown",
    },
  ]);

  world.setFailList("disconnected");
  const offline = await runtime.reconciler.refresh("/repo-a");
  assert.equal(offline.freshness, "offline");
  assert.deepEqual(offline.missingIds, []);
  assert.equal(offline.unadoptedCount, null);
  const snapshot = await runtime.store.read();
  assert.equal(
    snapshot.workspaces.find((item) => item.id === adopted.workspace.id)?.lifecycle,
    "active",
  );
  assert.equal(snapshot.freshnessByTargetId["host-a"], "offline");
  assert.equal(snapshot.unadoptedCountByBindingId[adopted.binding.id], 2);
  assert.deepEqual(snapshot.stoppedSessionIds, []);
  assert.equal(snapshot.sessionActivityById[running.session.id]?.activity, "running");
  assert.equal(snapshot.sessionActivityById[waiting.session.id]?.activity, "waiting");
  assert.notEqual(snapshot.sessionActivityById[running.session.id]?.lastTurn, "succeeded");
  assert.equal(await world.filesystem.exists("/repo-a"), true);

  await assert.rejects(
    runtime.worktrees.noteSessionActivities([
      {
        sessionId: running.session.id,
        activity: "idle",
        lastTurn: "succeeded",
        connection: "offline",
      },
      {
        sessionId: waiting.session.id,
        activity: "idle",
        lastTurn: "succeeded",
        connection: "offline",
      },
    ]),
    (error) => assertCode(error, "offline-activity-retained"),
  );
  const retained = await runtime.store.read();
  assert.equal(retained.sessionActivityById[running.session.id]?.activity, "running");
  assert.notEqual(retained.sessionActivityById[running.session.id]?.lastTurn, "succeeded");

  const index = await runtime.sidebar({
    activities: [
      {
        sessionId: running.session.id,
        activity: "idle",
        lastTurn: "succeeded",
        connection: "live",
      },
      {
        sessionId: waiting.session.id,
        activity: "idle",
        lastTurn: "succeeded",
        connection: "live",
      },
    ],
  });
  const row = index.projects[0]?.workspaces.find((item) => item.id === adopted.workspace.id);
  assert.equal(row?.targetFreshness, "offline");
  assert.equal(row?.sessionConnection, "offline");
  assert.equal(row?.counts.running, 1);
  assert.equal(row?.counts.attention, 1);
  assert.equal(row?.counts.idle, 0);
  assert.notEqual(row?.primary, "idle");
  assert.notEqual(row?.primary, "unread");
  assert.equal(index.discoveredNotAdopted, 2);
});

test("隐藏工作区有待审批时项目级仍有入口，归档和隐藏不删文件", async () => {
  const world = linkedWorld();
  const runtime = runtimeFor(world, "host-a");
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const session = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "待审批",
  });
  await runtime.worktrees.noteSessionActivities([
    {
      sessionId: session.session.id,
      activity: "waiting",
      pendingApproval: true,
      connection: "live",
    },
  ]);
  const removesBefore = world.calls.filter(
    (args) => args.includes("remove") || args.includes("prune"),
  ).length;
  await runtime.worktrees.setHidden(adopted.workspace.id, true);
  const hidden = await runtime.sidebar();
  const row = hidden.projects[0]?.workspaces.find((item) => item.id === adopted.workspace.id);
  assert.equal(row?.hidden, true);
  assert.equal(row?.counts.attention, 1);
  assert.deepEqual(hidden.projects[0]?.attentionWorkspaceIds, [adopted.workspace.id]);
  assert.equal(hidden.projects[0]?.attention, true);

  await runtime.worktrees.archiveWorkspace(adopted.workspace.id);
  assert.equal(await world.filesystem.exists("/repo-a"), true);
  assert.equal(await world.filesystem.exists("/repo/.git"), true);
  assert.equal(
    world.records.some((record) => record.path === "/repo-a"),
    true,
  );
  assert.equal(
    world.calls.filter((args) => args.includes("remove") || args.includes("prune")).length,
    removesBefore,
  );
  assert.equal(world.stopped.length, 0);
  const snapshot = await runtime.store.read();
  assert.equal(
    snapshot.workspaces.find((item) => item.id === adopted.workspace.id)?.lifecycle,
    "archived",
  );
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.hiddenWorkspaceIds.includes(adopted.workspace.id), true);
});
