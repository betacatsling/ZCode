import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionId, ProjectId, WorkspaceId } from "@zcode/contracts";
import type { LegacyMapping } from "../src/project-workspaces/migrationContract.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  createNativeProductionBridge,
  createReadonlyNativeDirectory,
  type NativeRuntimeFactsPort,
} from "../src/workspace-hierarchy/nativeProductionBridge.js";

const modelBinding = {
  kind: "host-managed" as const,
  selection: { providerId: "p", modelId: "m" },
};
function mapping(scope: string, workspaceId: string): LegacyMapping {
  return {
    legacyId: JSON.stringify([scope, "same"]),
    nativeSessionId: "same",
    sourceWorkspaceKey: scope,
    sourceWorkspacePath: scope,
    projectId: "project",
    workspaceId,
    targetId: "local",
    worktreeGeneration: `generation-${workspaceId}`,
    cwdRelativeToWorktree: ".",
    modelBinding,
  };
}

test("real SQLite index and native session store join by source scope, not parent worktree path", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-production-facts-"));
  const taskIndexDatabasePath = join(root, "configured-task-index.sqlite");
  const nativeSessionDatabasePath = join(root, "configured-cli.sqlite");
  const tasks = new TaskIndexRepo(taskIndexDatabasePath);
  const store = await SqliteSessionStore.openStartup({ dbPath: nativeSessionDatabasePath });
  let reads = 0;
  let fences = 0;
  let creates = 0;
  const activity = { running: 1, waiting: 2, tools: 3, uncertain: 4, offline: false };
  const runtime: NativeRuntimeFactsPort = {
    async create(input) {
      assert.equal(input.commandId, "intent-1");
      creates++;
      return { originalSessionId: "original-from-v4" };
    },
    async capabilities() {
      throw new Error("not requested");
    },
    async activity(workspaceId) {
      assert.equal(workspaceId, "nested");
      reads++;
      return activity;
    },
    async fenceAdmissions() {
      fences++;
      return async () => {
        fences--;
      };
    },
  };
  try {
    await tasks.ensureReady();
    for (const scope of ["/repo", "/repo/nested"]) {
      await tasks.syncTaskMeta({
        meta: {
          taskId: "same",
          traceId: "trace",
          title: scope,
          workspacePath: scope,
          createdAt: 1,
          updatedAt: 2,
          mode: "build",
          model: "p/m",
          provider: "p",
          thoughtLevel: "high",
          status: "running",
        },
      });
    }
    await tasks.syncTaskMeta({
      meta: {
        taskId: "child",
        traceId: "trace",
        title: "child",
        workspacePath: "/repo",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        model: "p/m",
        provider: "p",
        thoughtLevel: "high",
        status: "running",
      },
    });
    await tasks.syncTaskMeta({
      meta: {
        taskId: "legacy",
        traceId: "trace",
        title: "legacy",
        workspacePath: "/legacy",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        model: "p/m",
        provider: "p",
        thoughtLevel: "high",
        status: "completed",
      },
    });
    await store.createSession({
      id: "same" as SessionId,
      projectID: "project" as ProjectId,
      workspaceID: "/repo/nested" as WorkspaceId,
      slug: "s",
      directory: "/repo/nested",
      title: "Native",
      version: "1",
    });
    await store.createSession({
      id: "child" as SessionId,
      projectID: "project" as ProjectId,
      workspaceID: "/repo" as WorkspaceId,
      slug: "s",
      directory: "/repo/src",
      title: "Child",
      version: "1",
    });
    await store.createSession({
      id: "legacy" as SessionId,
      projectID: "project" as ProjectId,
      slug: "s",
      directory: "/legacy",
      title: "Legacy",
      version: "1",
    });
    let mappings = [
      mapping("/repo", "root"),
      mapping("/repo/nested", "nested"),
      { ...mapping("/repo", "root"), nativeSessionId: "child", cwdRelativeToWorktree: "src" },
      { ...mapping("/legacy", "legacy"), nativeSessionId: "legacy" },
    ];
    const directory = createReadonlyNativeDirectory({
      taskIndexDatabasePath,
      nativeSessionDatabasePath,
      backupDirectory: join(root, "unused-backups"),
      profileId: "profile",
      async listMappings() {
        return mappings;
      },
    });
    const bridge = createNativeProductionBridge({ directory, runtime, targetId: "local" });
    const rows = await bridge.nativeIndex.allSessions();
    assert.equal(rows.length, 2);
    assert.equal(creates, 0); // sidebar queries must never start a hidden V4 owner
    assert.deepEqual(rows.map((row) => row.session.title).sort(), ["/repo/nested", "child"]);
    assert.equal(rows[0]?.activity, "unknown"); // persisted 'running' is not a live heartbeat
    assert.equal(
      await bridge.native.resolveOwner({
        targetId: "local",
        workspaceId: "root",
        sessionId: "same",
      }),
      undefined,
    );
    const owner = await bridge.native.resolveOwner({
      targetId: "local",
      workspaceId: "nested",
      sessionId: "same",
    });
    assert.deepEqual(owner, {
      originalSessionId: "same",
      sourceWorkspacePath: "/repo/nested",
      workspaceIdentity: "/repo/nested",
    });
    assert.deepEqual(
      (
        await directory.resolveOwner({
          treeSessionId: rows.find((row) => row.session.title === "/repo/nested")!.session.id,
        })
      )?.owner,
      {
        targetId: "local",
        projectId: "project",
        workspaceId: "nested",
        worktreeGeneration: "generation-nested",
        sourceWorkspaceKey: "/repo/nested",
        sourceWorkspacePath: "/repo/nested",
        nativeSessionId: "same",
        cwdRelativeToWorktree: ".",
      },
    );
    assert.equal(
      await bridge.native.resolveOwner({
        targetId: "local",
        workspaceId: "legacy",
        sessionId: "legacy",
      }),
      undefined,
    );
    assert.deepEqual(
      (
        await directory.resolveOwner({
          targetId: "local",
          workspaceId: "root",
          sourceWorkspaceKey: "/repo",
          nativeSessionId: "child",
        })
      )?.owner.cwdRelativeToWorktree,
      "src",
    );
    assert.deepEqual(await bridge.nativeActivity("nested"), activity);
    assert.deepEqual(
      await bridge.native.create({
        scope: {
          workspaceId: "nested",
          targetId: "local",
          workspacePath: "/repo/nested",
          workspaceIdentity: "/repo/nested",
        },
        commandId: "intent-1",
        modelBinding,
        cwdRelativeToWorktree: ".",
      }),
      { originalSessionId: "original-from-v4" },
    );
    assert.equal(creates, 1);
    // 中文：即便 DB 的 workspaceID 一致，sidecar 源 path 错配也不能重新绑定旧 session。
    mappings = mappings.map((row) =>
      row.nativeSessionId === "child" ? { ...row, sourceWorkspacePath: "/" } : row,
    );
    assert.equal((await directory.allSessions()).length, 1);
    assert.equal(
      await bridge.native.resolveOwner({
        targetId: "local",
        workspaceId: "root",
        sessionId: "child",
      }),
      undefined,
    );
    assert.equal(creates, 1);
    assert.equal(reads, 1);
    const release = await bridge.nativeAdmissionFence();
    assert.equal(fences, 1);
    await release();
    assert.equal(fences, 0);
    await assert.rejects(() => stat(join(root, "unused-backups")), { code: "ENOENT" });
  } finally {
    store.close();
    tasks.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown configured CLI SQLite file fails closed and is never initialized by sidebar reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-production-missing-"));
  const tasks = new TaskIndexRepo(join(root, "tasks.sqlite"));
  try {
    await tasks.ensureReady();
    await tasks.syncTaskMeta({
      meta: {
        taskId: "same",
        traceId: "trace",
        title: "x",
        workspacePath: "/repo",
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        model: "p/m",
        provider: "p",
        thoughtLevel: "high",
        status: "completed",
      },
    });
    const directory = createReadonlyNativeDirectory({
      taskIndexDatabasePath: join(root, "tasks.sqlite"),
      nativeSessionDatabasePath: join(root, "missing.sqlite"),
      backupDirectory: join(root, "backups"),
      profileId: "profile",
      async listMappings() {
        return [mapping("/repo", "root")];
      },
    });
    await assert.rejects(() => directory.allSessions());
    const noMappings = createReadonlyNativeDirectory({
      taskIndexDatabasePath: join(root, "tasks.sqlite"),
      nativeSessionDatabasePath: join(root, "missing.sqlite"),
      backupDirectory: join(root, "backups"),
      profileId: "profile",
      async listMappings() {
        return [];
      },
    });
    await assert.rejects(() => noMappings.allSessions());
    await assert.rejects(() => stat(join(root, "missing.sqlite")), { code: "ENOENT" });
    assert.throws(
      () =>
        createReadonlyNativeDirectory({
          taskIndexDatabasePath: "relative.sqlite",
          nativeSessionDatabasePath: join(root, "missing.sqlite"),
          backupDirectory: join(root, "backups"),
          profileId: "profile",
          async listMappings() {
            return [];
          },
        }),
      /configured-absolute-paths/,
    );
  } finally {
    tasks.close();
    await rm(root, { recursive: true, force: true });
  }
});
