import assert from "node:assert/strict";
import test from "node:test";
import { createProjectWorkspaces } from "./index.js";
import { createMemoryCatalogStore } from "./store.js";
import { assertCode, createWorkspaceWorld } from "./projectWorkspaces.test-support.js";

/** 假传输上的重复次数。不是多小时浸泡。 */
const ITERATIONS = 40;

function linkedWorld() {
  const world = createWorkspaceWorld({
    "/repo": { device: 1, inode: 1 },
    "/repo/.git": { device: 1, inode: 2 },
    "/repo-a": { device: 1, inode: 3 },
  });
  world.records.push(
    { path: "/repo", oid: "aaa111", branch: "develop" },
    { path: "/repo-a", oid: "bbb222", branch: "main" },
  );
  return world;
}

test("假传输下同一工作区多会话断线后不重放成已完成", async () => {
  const world = linkedWorld();
  const runtime = createProjectWorkspaces({
    executionTargetId: "host-a",
    git: world.git,
    filesystem: world.filesystem,
    activity: world.activityPort,
    store: createMemoryCatalogStore(),
    idFactory: world.idFactory,
    knownHarnessIds: ["pi", "codex", "claude-code"],
  });
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const titles = ["一", "二", "三"] as const;
  const created = [];
  for (const title of titles) {
    created.push(
      await runtime.worktrees.createAgentSession({
        workspaceId: adopted.workspace.id,
        harnessId: "pi",
        title,
      }),
    );
  }
  const ids = created.map((item) => item.session.id);
  await runtime.worktrees.noteSessionActivities(
    ids.map((sessionId) => ({
      sessionId,
      activity: "running" as const,
      connection: "live" as const,
      lastTurn: "unknown" as const,
    })),
  );
  for (let i = 0; i < ITERATIONS; i += 1) {
    world.setFailList("disconnected");
    const offline = await runtime.reconciler.refresh("/repo-a");
    assert.equal(offline.freshness, "offline");
    const snapshot = await runtime.store.read();
    assert.deepEqual(snapshot.sessions.map((session) => session.id).sort(), [...ids].sort());
    for (const sessionId of ids) {
      assert.equal(snapshot.sessionActivityById[sessionId]?.activity, "running");
      assert.notEqual(snapshot.sessionActivityById[sessionId]?.lastTurn, "succeeded");
    }
    await assert.rejects(
      runtime.worktrees.noteSessionActivities(
        ids.map((sessionId) => ({
          sessionId,
          activity: "idle" as const,
          lastTurn: "succeeded" as const,
          connection: "offline" as const,
        })),
      ),
      (error) => assertCode(error, "offline-activity-retained"),
    );
  }
  assert.equal(await world.filesystem.exists("/repo-a"), true);
});

test("假传输下删除进行中持续拒绝新会话", async () => {
  for (let i = 0; i < ITERATIONS; i += 1) {
    const world = linkedWorld();
    const runtime = createProjectWorkspaces({
      executionTargetId: "host-a",
      git: world.git,
      filesystem: world.filesystem,
      activity: world.activityPort,
      store: createMemoryCatalogStore(),
      idFactory: world.idFactory,
      knownHarnessIds: ["pi", "codex"],
    });
    const project = await runtime.catalog.createProject({ name: "Repo" });
    const adopted = await runtime.worktrees.adopt({
      projectId: project.id,
      worktreePath: "/repo-a",
    });
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
    assert.equal(world.stopped.length, 0);
    assert.equal(
      (await runtime.worktrees.listSessions(adopted.workspace.id))[0]?.id,
      session.session.id,
    );
    world.releaseRemove();
    const removed = await removal;
    assert.equal(removed.status, "removed");
  }
});
