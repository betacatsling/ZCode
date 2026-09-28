import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryCatalogStore } from "./store.js";
import { createLegacyWorkspaceMigration, type LegacySessionInput } from "./legacyWorkspaceMigration.js";
import { assertCode } from "./projectWorkspaces.test-support.js";

const head = { kind: "branch" as const, ref: "develop", oid: "abc123" };

function gitSession(patch: Partial<LegacySessionInput> & Pick<LegacySessionInput, "nativeSessionId">): LegacySessionInput {
  return {
    source: "storage-index",
    title: patch.nativeSessionId,
    harnessId: "pi",
    workspacePath: "/repo",
    executionTargetId: "host-a",
    cwd: "/repo/src/app",
    originUrl: "git@example.com:repo.git",
    resolution: {
      status: "git",
      worktreeRoot: "/repo",
      gitCommonDir: "/repo/.git",
      isMainWorktree: true,
      head,
      evidence: { device: 1, inode: 1 },
    },
    ...patch,
  };
}

test("迁移只映射存储索引，保留子目录 cwd，且可重入", async () => {
  const store = createMemoryCatalogStore();
  const migration = createLegacyWorkspaceMigration({ store, knownHarnessIds: ["pi", "zcode"] });
  const sessions: LegacySessionInput[] = [
    gitSession({ nativeSessionId: "native-1", title: "一", modelBinding: { model: "glm" } }),
    gitSession({
      nativeSessionId: "native-2",
      title: "二",
      harnessId: "zcode",
      cwd: "/repo",
    }),
    gitSession({
      nativeSessionId: "tab-only",
      source: "open-tab",
      title: "不该建项目",
    }),
  ];
  const preview = migration.plan(sessions);
  assert.equal((await store.read()).projects.length, 0);
  assert.equal(preview.sessions.some((session) => session.id === "tab-only"), false);
  await assert.rejects(migration.apply(sessions, { backupConfirmed: false }), (error) =>
    assertCode(error, "backup-required"),
  );
  const applied = await migration.apply(sessions, { backupConfirmed: true });
  const again = await migration.apply(sessions, { backupConfirmed: true });
  const snapshot = await store.read();
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.workspaces.length, 1);
  assert.equal(snapshot.sessions.length, 2);
  assert.deepEqual(
    snapshot.sessions.map((session) => session.id).sort(),
    ["native-1", "native-2"],
  );
  assert.equal(snapshot.sessionCwdById["native-1"], "src/app");
  assert.notEqual(snapshot.sessionCwdById["native-1"], ".");
  assert.equal(snapshot.sessionCwdById["native-2"], ".");
  assert.equal(applied.mappings.find((mapping) => mapping.nativeSessionId === "native-1")?.modelBinding && true, true);
  assert.equal(again.fingerprint, applied.fingerprint);
  assert.equal(snapshot.workspaces[0]?.head.kind === "branch" && snapshot.workspaces[0].head.ref, "develop");
  assert.notEqual(snapshot.workspaces[0]?.id, "develop");
});

test("同路径的两台主机、两份 clone 和 submodule 不串归属", async () => {
  const store = createMemoryCatalogStore();
  const migration = createLegacyWorkspaceMigration({ store, knownHarnessIds: ["pi"] });
  await migration.apply(
    [
      gitSession({ nativeSessionId: "a", executionTargetId: "host-a" }),
      gitSession({ nativeSessionId: "b", executionTargetId: "host-b", workspaceIdentity: "remote-b" }),
      gitSession({
        nativeSessionId: "clone",
        executionTargetId: "host-a",
        workspacePath: "/clone",
        cwd: "/clone",
        originUrl: "git@example.com:repo.git",
        resolution: {
          status: "git",
          worktreeRoot: "/clone",
          gitCommonDir: "/clone/.git",
          isMainWorktree: true,
          head,
          evidence: { device: 2, inode: 2 },
        },
      }),
      gitSession({
        nativeSessionId: "sub",
        workspacePath: "/repo/vendor/lib",
        cwd: "/repo/vendor/lib/src",
        resolution: {
          status: "git",
          worktreeRoot: "/repo/vendor/lib",
          gitCommonDir: "/repo/vendor/lib/.git",
          isMainWorktree: true,
          head,
          evidence: { device: 3, inode: 3 },
        },
      }),
    ],
    { backupConfirmed: true },
  );
  const snapshot = await store.read();
  assert.equal(snapshot.projects.length, 4);
  assert.equal(new Set(snapshot.bindings.map((binding) => binding.executionTargetId)).size, 2);
  assert.equal(snapshot.sessions.find((session) => session.id === "sub")?.workspaceId === snapshot.sessions.find((session) => session.id === "a")?.workspaceId, false);
});

test("离线、未知 Harness、重建和普通文件夹进入待核实，不替换默认 Harness", async () => {
  const store = createMemoryCatalogStore();
  const migration = createLegacyWorkspaceMigration({ store, knownHarnessIds: ["pi"] });
  const plan = await migration.apply(
    [
      gitSession({ nativeSessionId: "off", resolution: { status: "offline" } }),
      gitSession({ nativeSessionId: "missing", resolution: { status: "missing" } }),
      gitSession({ nativeSessionId: "plain", resolution: { status: "non-git" } }),
      gitSession({ nativeSessionId: "rebuilt", resolution: { status: "rebuilt" } }),
      gitSession({ nativeSessionId: "unknown", harnessId: "mystery-agent" }),
      gitSession({
        nativeSessionId: "conflict-a",
        workspaceIdentity: "one",
        workspacePath: "/repo",
      }),
      gitSession({
        nativeSessionId: "conflict-b",
        workspaceIdentity: "two",
        workspacePath: "/repo",
      }),
    ],
    { backupConfirmed: true },
  );
  assert.equal((await store.read()).sessions.length, 0);
  const reasons = new Map(plan.mappings.map((mapping) => [mapping.nativeSessionId, mapping.reason]));
  assert.equal(reasons.get("off"), "offline");
  assert.equal(reasons.get("missing"), "missing");
  assert.equal(reasons.get("plain"), "plain-folder");
  assert.equal(reasons.get("rebuilt"), "needs-verification");
  assert.equal(reasons.get("unknown"), "unknown-harness");
  assert.equal(plan.mappings.find((mapping) => mapping.nativeSessionId === "unknown")?.harnessId, "mystery-agent");
  assert.equal(reasons.get("conflict-a"), "identity-conflict");
  assert.equal(reasons.get("conflict-b"), "identity-conflict");
});
