import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileCatalogStore, createMemoryCatalogStore } from "./store.js";
import type { CatalogSnapshot } from "./snapshot.js";
import type { MigrationBackupWriter } from "./ports.js";
import {
  createLegacyWorkspaceMigration,
  type LegacySessionInput,
} from "./legacyWorkspaceMigration.js";
import { assertCode } from "./projectWorkspaces.test-support.js";

const head = { kind: "branch" as const, ref: "develop", oid: "abc123" };

function memoryBackup(): MigrationBackupWriter & { copies: CatalogSnapshot[] } {
  const copies: CatalogSnapshot[] = [];
  return {
    copies,
    async write(backup) {
      copies.push(backup.catalog);
    },
  };
}

function gitSession(
  patch: Partial<LegacySessionInput> & Pick<LegacySessionInput, "nativeSessionId">,
): LegacySessionInput {
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
  assert.equal(
    preview.sessions.some((session) => session.id === "tab-only"),
    false,
  );
  const backup = memoryBackup();
  const applied = await migration.apply(sessions, { backup });
  const again = await migration.apply(sessions, { backup });
  assert.equal(backup.copies.length, 2);
  assert.equal(backup.copies[0]?.projects.length, 0);
  const snapshot = await store.read();
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.workspaces.length, 1);
  assert.equal(snapshot.sessions.length, 2);
  assert.deepEqual(snapshot.sessions.map((session) => session.id).sort(), ["native-1", "native-2"]);
  assert.equal(snapshot.sessionCwdById["native-1"], "src/app");
  assert.notEqual(snapshot.sessionCwdById["native-1"], ".");
  assert.equal(snapshot.sessionCwdById["native-2"], ".");
  assert.equal(
    applied.mappings.find((mapping) => mapping.nativeSessionId === "native-1")?.modelBinding &&
      true,
    true,
  );
  assert.equal(again.fingerprint, applied.fingerprint);
  assert.equal(
    snapshot.workspaces[0]?.head.kind === "branch" && snapshot.workspaces[0].head.ref,
    "develop",
  );
  assert.notEqual(snapshot.workspaces[0]?.id, "develop");
});

test("同路径的两台主机、两份 clone 和 submodule 不串归属", async () => {
  const store = createMemoryCatalogStore();
  const migration = createLegacyWorkspaceMigration({ store, knownHarnessIds: ["pi"] });
  await migration.apply(
    [
      gitSession({ nativeSessionId: "a", executionTargetId: "host-a" }),
      gitSession({
        nativeSessionId: "b",
        executionTargetId: "host-b",
        workspaceIdentity: "remote-b",
      }),
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
    { backup: memoryBackup() },
  );
  const snapshot = await store.read();
  assert.equal(snapshot.projects.length, 4);
  assert.equal(new Set(snapshot.bindings.map((binding) => binding.executionTargetId)).size, 2);
  assert.equal(
    snapshot.sessions.find((session) => session.id === "sub")?.workspaceId ===
      snapshot.sessions.find((session) => session.id === "a")?.workspaceId,
    false,
  );
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
    { backup: memoryBackup() },
  );
  assert.equal((await store.read()).sessions.length, 0);
  const reasons = new Map(
    plan.mappings.map((mapping) => [mapping.nativeSessionId, mapping.reason]),
  );
  assert.equal(reasons.get("off"), "offline");
  assert.equal(reasons.get("missing"), "missing");
  assert.equal(reasons.get("plain"), "plain-folder");
  assert.equal(reasons.get("rebuilt"), "needs-verification");
  assert.equal(reasons.get("unknown"), "unknown-harness");
  assert.equal(
    plan.mappings.find((mapping) => mapping.nativeSessionId === "unknown")?.harnessId,
    "mystery-agent",
  );
  assert.equal(reasons.get("conflict-a"), "identity-conflict");
  assert.equal(reasons.get("conflict-b"), "identity-conflict");
});

test("没有备份写入器时拒绝迁移，目录保持原样", async () => {
  const store = createMemoryCatalogStore();
  const migration = createLegacyWorkspaceMigration({ store, knownHarnessIds: ["pi"] });
  await assert.rejects(
    migration.apply([gitSession({ nativeSessionId: "native-1" })], undefined as never),
    (error) => assertCode(error, "backup-required"),
  );
  assert.equal((await store.read()).projects.length, 0);
});

test("假数据目录先备份再升级，回滚后恢复迁移前快照且不删除工作区路径", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-migration-rollback-"));
  const workspacePath = join(root, "repo");
  try {
    const catalogPath = join(root, "catalog.json");
    const backupPath = join(root, "catalog.backup.json");
    const store = createFileCatalogStore(catalogPath);
    const migration = createLegacyWorkspaceMigration({ store, knownHarnessIds: ["pi"] });
    const sessions = [
      gitSession({
        nativeSessionId: "native-rollback",
        workspacePath,
        cwd: join(workspacePath, "src"),
        resolution: {
          status: "git",
          worktreeRoot: workspacePath,
          gitCommonDir: join(workspacePath, ".git"),
          isMainWorktree: true,
          head,
          evidence: { device: 9, inode: 9 },
        },
      }),
    ];
    const preview = migration.plan(sessions);
    assert.equal((await store.read()).projects.length, 0);
    assert.equal(preview.sessions.length, 1);
    const backup: MigrationBackupWriter = {
      async write(payload) {
        await writeFile(backupPath, JSON.stringify(payload.catalog), "utf8");
      },
    };
    await migration.apply(sessions, { backup });
    const upgraded = await store.read();
    assert.equal(upgraded.sessions.length, 1);
    assert.equal(upgraded.sessions[0]?.id, "native-rollback");
    const saved = await readFile(backupPath, "utf8");
    const restored = JSON.parse(saved) as CatalogSnapshot;
    assert.equal(restored.projects.length, 0);
    await writeFile(catalogPath, saved, "utf8");
    assert.equal((await store.read()).projects.length, 0);
    assert.equal((await store.read()).sessions.length, 0);
    assert.equal(workspacePath.includes(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
