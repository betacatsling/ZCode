import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { SESSION_ENTRY_MODEL_SELECTION, type SessionId, type ProjectId } from "@zcode/contracts";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import {
  NativePersistentSessionIndex,
  NativeSessionStoreMetadataReader,
} from "../src/session/nativePersistentSessionIndex.js";
import { NativeSessionDirectory } from "../src/session/nativeSessionDirectory.js";
import { LegacyWorkspaceMigration } from "../src/project-workspaces/legacyWorkspaceMigration.js";
import { hierarchyFixture } from "./fixtures/hierarchy.js";
const git = promisify(execFile);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "native-index-"));
  const databasePath = join(dir, "tasks-index.sqlite");
  const repo = new TaskIndexRepo(databasePath);
  await repo.ensureReady();
  const cwdByKey = new Map<string, string>();
  const reader = new NativePersistentSessionIndex(databasePath, join(dir, "backups"), "fixture", {
    async read({ workspaceKey }) {
      const cwd = cwdByKey.get(workspaceKey);
      return cwd ? { cwd, targetId: "local" } : undefined;
    },
  });
  const write = async (
    workspacePath: string,
    workspaceIdentity: string | undefined,
    model: string,
  ) => {
    cwdByKey.set(workspaceIdentity || workspacePath, workspacePath);
    await repo.syncTaskMeta({
      meta: {
        taskId: "same-id",
        traceId: "trace-test",
        title: workspacePath,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        createdAt: 1,
        updatedAt: 2,
        mode: "build",
        model,
        provider: "glm",
        thoughtLevel: "high",
        status: "completed",
      },
    });
  };
  return { dir, databasePath, repo, reader, write, cwdByKey };
}

test("public native session-store metadata supplies actual cwd and exact model without rewriting history", async () => {
  const f = await fixture();
  const nativeStore = await SqliteSessionStore.openStartup({
    dbPath: join(f.dir, "native-sessions.sqlite"),
  });
  try {
    await nativeStore.createSession({
      id: "same-id" as SessionId,
      projectID: "project" as ProjectId,
      slug: "test",
      directory: "/repo/src",
      title: "Stored",
      version: "1",
    });
    await nativeStore.saveSessionEntry({
      id: "selection",
      sessionID: "same-id" as SessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      time: { created: 1, updated: 2 },
      data: {
        providerId: "provider",
        modelId: "name/with-slash",
        options: { reasoningLevel: "high" },
      },
    });
    await f.write("/repo", undefined, "ambiguous/name/with-slash");
    const reader = new NativePersistentSessionIndex(
      f.databasePath,
      join(f.dir, "native-backups"),
      "fixture",
      new NativeSessionStoreMetadataReader(nativeStore, async () => "local"),
    );
    const exported = await reader.exportAll();
    assert.equal(exported.records[0]?.nativeCwd, "/repo/src");
    assert.equal(exported.records[0]?.workspacePath, "/repo");
    assert.deepEqual(exported.records[0]?.modelBinding, {
      kind: "host-managed",
      selection: {
        providerId: "provider",
        modelId: "name/with-slash",
        options: { reasoningLevel: "high" },
      },
    });
    const backup = await reader.backup(exported);
    assert.equal(await reader.verifyBackup(backup), true);
    assert.equal((await nativeStore.getSession("same-id" as SessionId))?.directory, "/repo/src");
    const wrong = new NativeSessionStoreMetadataReader(nativeStore, async () => "local");
    assert.equal(
      await wrong.read({
        workspaceKey: "/unrelated",
        workspacePath: "/unrelated",
        nativeSessionId: "same-id",
      }),
      undefined,
    );
    await nativeStore.saveSessionEntry({
      id: "invalid-selection",
      sessionID: "same-id" as SessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      time: { created: 3, updated: 4 },
      data: { providerId: "provider", modelId: "" },
    });
    const invalid = await reader.exportAll();
    assert.equal(invalid.records[0]?.modelBinding, undefined);
    assert.equal(
      await wrong.read({
        workspaceKey: buildRemoteWorkspaceIdentity("/repo", {
          kind: "ssh",
          host: "test.invalid",
          username: "test",
        }),
        workspacePath: "/repo",
        nativeSessionId: "same-id",
      }),
      undefined,
    );
    const noTarget = new NativeSessionStoreMetadataReader(nativeStore, async () => undefined);
    assert.equal(
      await noTarget.read({
        workspaceKey: "/repo",
        workspacePath: "/repo",
        nativeSessionId: "same-id",
      }),
      undefined,
    );
  } finally {
    nativeStore.close();
    f.repo.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("ordinary native summary reads committed WAL changes without backup or stored waiting claim", async () => {
  const f = await fixture();
  try {
    await f.write("/repo", undefined, "p/m");
    let invalidations = 0;
    const unsubscribe = f.reader.onChange(() => {
      invalidations++;
    });
    assert.equal((await f.reader.readFacts())[0]?.title, "/repo");
    assert.equal(invalidations, 0);
    await assert.rejects(() => stat(join(f.dir, "backups")), /ENOENT/);
    await f.repo.syncTaskMeta({
      meta: {
        taskId: "same-id",
        traceId: "trace-test",
        title: "changed",
        workspacePath: "/repo",
        createdAt: 1,
        updatedAt: 7,
        mode: "build",
        model: "p/m",
        provider: "glm",
        status: "running",
        pendingInteraction: { type: "question", prompt: "not-live" },
      },
    });
    const changed = (await f.reader.readFacts())[0]!;
    assert.equal(changed.title, "changed");
    assert.equal(changed.updatedAt, 7);
    assert.equal(invalidations, 1);
    assert.equal("waiting" in changed, false);
    assert.equal((await f.reader.readFacts())[0]?.title, "changed");
    assert.equal(invalidations, 1);
    unsubscribe();
    await assert.rejects(() => stat(join(f.dir, "backups")), /ENOENT/);
  } finally {
    f.repo.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("native SQLite WAL export includes closed scopes, stays isolated and backup survives restart", async () => {
  const f = await fixture();
  try {
    await f.write("/repo/a", undefined, "provider/model");
    const first = await f.reader.exportAll();
    const same = first.records[0]!;
    assert.equal(same.nativeSessionId, "same-id");
    assert.deepEqual(same.modelBinding, {
      kind: "host-managed",
      selection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
    await f.write("/repo/b", "other-scope", "ambiguous/provider/model");
    await f.repo.syncTaskMeta({
      meta: {
        taskId: "same-id",
        traceId: "trace-test",
        title: "archived",
        workspacePath: "/repo/b",
        workspaceIdentity: "other-scope",
        createdAt: 1,
        updatedAt: 3,
        mode: "build",
        model: "ambiguous/provider/model",
        provider: "glm",
        status: "completed",
      },
      archived: true,
      deleted: true,
    });
    const next = await f.reader.exportAll();
    assert.equal(
      (await f.reader.readFacts()).find((row) => row.workspaceKey === "other-scope")?.deleted,
      true,
    );
    assert.equal(next.records.length, 2);
    assert.notEqual(next.records[0]?.id, next.records[1]?.id);
    assert.equal(
      next.records.find((record) => record.workspaceKey === "other-scope")?.modelBinding,
      undefined,
    );
    await assert.rejects(() => f.reader.backup(first), /legacy-index-changed/);
    const backup = await f.reader.backup(next);
    assert.equal(await f.reader.verifyBackup(backup), true);
    f.repo.close();
    const restarted = new NativePersistentSessionIndex(
      f.databasePath,
      join(f.dir, "backups"),
      "fixture",
      {
        async read() {
          return undefined;
        },
      },
    );
    assert.equal(await restarted.verifyBackup(backup), true);
    const file = join(f.dir, "backups", `${backup.backupId}.sqlite`);
    const bytes = await readFile(file);
    await writeFile(file, Buffer.concat([bytes, Buffer.from("damage")]));
    assert.equal(await restarted.verifyBackup(backup), false);
  } finally {
    f.repo.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("durable backup failure does not publish migration sidecar", async () => {
  const f = await fixture();
  try {
    await f.write("/repo", undefined, "p/m");
    const blockedDirectory = join(f.dir, "blocked-backups");
    await writeFile(blockedDirectory, "not-a-directory");
    const reader = new NativePersistentSessionIndex(f.databasePath, blockedDirectory, "fixture", {
      async read() {
        return { cwd: "/repo", targetId: "local" };
      },
    });
    const sidecar = join(f.dir, "failed-migration.json");
    const migration = await LegacyWorkspaceMigration.open(sidecar, reader, {
      async resolve() {
        return {
          binding: { ...hierarchyFixture.bindings[0]!, executionTargetId: "local" },
          workspace: hierarchyFixture.workspaces[0]!,
          cwdRelativeToWorktree: ".",
        };
      },
    });
    try {
      await assert.rejects(() => migration.apply());
      await assert.rejects(() => readFile(sidecar));
    } finally {
      await migration.close();
    }
  } finally {
    f.repo.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("native directory joins identical task IDs only within their original workspace and target", async () => {
  const f = await fixture();
  try {
    await f.write("/repo/a", undefined, "p/m");
    await f.write("/repo/b", undefined, "p/m");
    const records = (await f.reader.exportAll()).records;
    const mappings = records.map((record, i) => ({
      legacyId: record.id,
      nativeSessionId: record.nativeSessionId,
      sourceWorkspaceKey: record.workspaceKey,
      sourceWorkspacePath: record.workspacePath,
      projectId: `project-${i}`,
      workspaceId: `worktree-${i}`,
      targetId: `target-${i}`,
      worktreeGeneration: `generation-${i}`,
      cwdRelativeToWorktree: ".",
      modelBinding: record.modelBinding!,
    }));
    const directory = new NativeSessionDirectory({
      async listMappings() {
        return mappings;
      },
      readFacts: () => f.reader.readFacts(),
    });
    const treeRows = await directory.allSessions();
    assert.equal(treeRows.length, 2);
    assert.notEqual(treeRows[0]?.session.id, treeRows[1]?.session.id);
    assert.ok(
      treeRows.every(({ session }) => session.id.startsWith("native:") && session.id.length < 256),
    );
    assert.equal(
      (
        await directory.resolveOwner({
          targetId: "target-1",
          workspaceId: "worktree-1",
          sourceWorkspaceKey: "/repo/b",
          nativeSessionId: "same-id",
        })
      )?.owner.sourceWorkspacePath,
      "/repo/b",
    );
    assert.equal(
      await directory.resolveOwner({
        targetId: "target-1",
        workspaceId: "worktree-1",
        sourceWorkspaceKey: "/repo/a",
        nativeSessionId: "same-id",
      }),
      undefined,
    );
  } finally {
    f.repo.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("unknown native raw schema and missing definitive cwd fail closed", async () => {
  const f = await fixture();
  try {
    await f.write("/repo", undefined, "p/m");
    f.cwdByKey.clear();
    const pending = (await f.reader.exportAll()).records[0]!;
    assert.equal(pending.targetId, undefined);
    assert.equal(pending.cwdRelativeToWorktree, undefined);
    const db = new DatabaseSync(f.databasePath);
    try {
      db.exec("ALTER TABLE tasks ADD COLUMN future_field TEXT");
    } finally {
      db.close();
    }
    await assert.rejects(() => f.reader.exportAll(), /unknown-native-schema/);
  } finally {
    f.repo.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("actual Git subdirectory maps with native scope retained and target-isolated directory", async () => {
  const f = await fixture();
  const root = join(f.dir, "source");
  const tree = join(f.dir, "worktree");
  const subdir = join(tree, "src");
  const sidecar = join(f.dir, "migration.json");
  try {
    await mkdir(root);
    await git("git", ["init", "-q", root]);
    await git("git", [
      "-C",
      root,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    await git("git", ["-C", root, "worktree", "add", "-qb", "fixture-tree", tree]);
    await mkdir(subdir);
    await f.write(subdir, undefined, "p/m");
    await f.write(tree, undefined, "p/m");
    f.cwdByKey.set(tree, subdir); // native session's working directory can differ from its indexed routing scope
    const workspace = {
      ...hierarchyFixture.workspaces[0]!,
      worktreePath: tree,
      workspaceIdentity: tree,
    };
    const binding = { ...hierarchyFixture.bindings[0]!, executionTargetId: "local" };
    assert.deepEqual(await f.reader.exportAll(), await f.reader.exportAll());
    const migration = await LegacyWorkspaceMigration.open(sidecar, f.reader, {
      async resolve(record) {
        const canonical = await realpath(record.nativeCwd!);
        const gitRoot = (
          await git("git", ["-C", canonical, "rev-parse", "--show-toplevel"])
        ).stdout.trim();
        if (gitRoot !== (await realpath(tree))) return undefined;
        return { binding, workspace, cwdRelativeToWorktree: relative(gitRoot, canonical) || "." };
      },
    });
    try {
      const preview = await migration.apply();
      assert.equal(preview.pending.length, 0);
      assert.equal(preview.mapped.length, 2);
      assert.equal(
        preview.mapped.find((row) => row.sourceWorkspacePath === subdir)?.cwdRelativeToWorktree,
        "src",
      );
      assert.equal(
        preview.mapped.find((row) => row.sourceWorkspacePath === tree)?.cwdRelativeToWorktree,
        "src",
      );
      const directory = new NativeSessionDirectory({
        listMappings: () => migration.listMappings(),
        readFacts: () => f.reader.readFacts(),
      });
      const ref = await directory.resolveOwner({
        targetId: "local",
        workspaceId: workspace.id,
        sourceWorkspaceKey: subdir,
        nativeSessionId: "same-id",
      });
      assert.equal(ref?.owner.cwdRelativeToWorktree, "src");
      assert.equal(
        await directory.resolveOwner({
          targetId: "other",
          workspaceId: workspace.id,
          sourceWorkspaceKey: subdir,
          nativeSessionId: "same-id",
        }),
        undefined,
      );
      assert.equal((await directory.allSessions()).length, 2);
      const persisted = JSON.parse(await readFile(sidecar, "utf8")) as {
        source: { backupId: string };
      };
      const backupFile = join(f.dir, "backups", `${persisted.source.backupId}.sqlite`);
      const bytes = await readFile(backupFile);
      await writeFile(backupFile, Buffer.concat([bytes, Buffer.from("corrupt")]));
      await assert.rejects(() => directory.allSessions(), /unverified-native-backup/);
      await assert.rejects(() => migration.rollback(), /unverified-native-backup/);
      await writeFile(backupFile, bytes);
      await migration.rollback();
      assert.equal((await directory.allSessions()).length, 0);
    } finally {
      await migration.close();
    }
  } finally {
    f.repo.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
