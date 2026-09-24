import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectCatalogTargetPort } from "../src/project-workspaces/serviceContract.js";
import { ProjectCatalog } from "../src/project-workspaces/projectCatalog.js";
import { LegacyWorkspaceMigration } from "../src/project-workspaces/legacyWorkspaceMigration.js";
import { hierarchyFixture } from "./fixtures/hierarchy.js";

const original = hierarchyFixture.workspaces[0]!;
function port(): ProjectCatalogTargetPort & { calls: string[] } {
  const calls: string[] = [];
  const adopted = new Map<string, typeof original>();
  return {
    calls,
    async inspectRepository({ targetId }) {
      calls.push("inspect");
      return { executionTargetId: targetId, gitCommonDir: "/same/.git" };
    },
    async sameRepository() {
      return false;
    },
    async registerBinding() {},
    async setArchivePolicy() {},
    async previewRemoval(workspaceId, generation) {
      return { workspaceId, generation, git: null, activity: null, unknown: true, safe: false };
    },
    async discover(binding) {
      calls.push("discover");
      return [
        {
          repositoryBindingId: binding.id,
          worktreePath: "/same",
          workspaceIdentity: `${binding.executionTargetId}:same`,
          worktreeGeneration: "g1",
          isMainWorktree: true,
          head: original.head,
        },
      ];
    },
    async adopt({ binding, workspaceId, title, sortOrder, worktreePath }) {
      calls.push("adopt");
      const workspace = {
        ...original,
        id: workspaceId,
        projectId: binding.projectId,
        repositoryBindingId: binding.id,
        title,
        sortOrder,
        worktreePath,
        workspaceIdentity: `${binding.executionTargetId}:${worktreePath.slice(1)}`,
        hidden: false,
      };
      adopted.set(workspaceId, workspace);
      return workspace;
    },
    async create(input) {
      calls.push("create");
      return { ...(await this.adopt(input)), origin: "created" };
    },
    async remove(input) {
      calls.push("remove");
      return { ...adopted.get(input.workspaceId)!, lifecycle: "removed" as const };
    },
  };
}
const index = {
  async allSessions() {
    return [];
  },
  async workspaceFreshness() {
    return "offline" as const;
  },
};

test("catalog persists empty projects, order and preferences without tabs, second owner refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
  const path = join(dir, "catalog.json");
  const target = port();
  try {
    const catalog = await ProjectCatalog.open(path, target, index);
    assert.deepEqual((await catalog.sidebarSnapshot()).projects, []);
    const changes: number[] = [];
    catalog.onChange((revision) => changes.push(revision));
    const rpcChanges: number[] = [];
    const subscription = catalog.onDidChange((revision) => rpcChanges.push(revision));
    await catalog.importProject({
      id: "p1",
      bindingId: "b1",
      name: "One",
      targetId: "local",
      repositoryPath: "/same",
    });
    await assert.rejects(() => ProjectCatalog.open(path, target, index), /EEXIST/);
    assert.deepEqual(await catalog.discover("b1"), [
      {
        repositoryBindingId: "b1",
        worktreePath: "/same",
        workspaceIdentity: "local:same",
        worktreeGeneration: "g1",
        isMainWorktree: true,
        head: original.head,
      },
    ]);
    assert.equal((await catalog.sidebarSnapshot()).workspaces.length, 0); // discovery does not adopt
    await catalog.adopt({
      bindingId: "b1",
      workspaceId: "w1",
      title: "Main",
      worktreePath: "/same",
    });
    await catalog.updateWorkspace("w1", { hidden: true, archived: true });
    await catalog.updateProject("p1", {
      name: "Renamed",
      pinned: true,
      hidden: true,
      defaultWorkspaceId: "w1",
    });
    await assert.rejects(
      () =>
        catalog.create({
          bindingId: "missing",
          workspaceId: "w2",
          title: "Feature",
          worktreePath: "/feature",
          baseRef: "main",
          branch: "feature",
        }),
      /unknown-binding/,
    );
    await assert.rejects(
      () => catalog.remove({ workspaceId: "w1", expectedGeneration: "stale", confirmation: true }),
      /stale-workspace/,
    );
    assert.deepEqual(changes, [1, 2, 3, 4]);
    assert.deepEqual(rpcChanges, changes);
    assert.equal(await catalog.getRevision(), 4);
    subscription.dispose();
    assert.deepEqual(target.calls, ["inspect", "discover", "adopt"]);
    await catalog.close();
    const restored = await ProjectCatalog.open(path, target, index);
    assert.equal((await restored.project("p1"))?.name, "Renamed");
    assert.equal((await restored.project("p1"))?.hidden, true);
    assert.equal((await restored.sidebarSnapshot()).workspaces[0]?.lifecycle, "active");
    assert.equal((await restored.sidebarSnapshot()).workspaces[0]?.archived, true);
    const created = await restored.apply({
      kind: "create",
      repositoryBindingId: "b1",
      workspaceId: "w2",
      title: "Feature",
      worktreePath: "/feature",
      baseRef: "main",
      branch: "feature",
    });
    assert.equal(Array.isArray(created), false);
    assert.equal((await restored.sidebarSnapshot()).workspaces.length, 2);
    await assert.rejects(
      () =>
        restored.apply({
          kind: "remove",
          workspaceId: "w2",
          expectedGeneration: "wrong",
          confirmation: true,
        }),
      /stale-workspace/,
    );
    await restored.remove({
      workspaceId: "w1",
      expectedGeneration: original.worktreeGeneration,
      confirmation: true,
    });
    assert.equal((await restored.sidebarSnapshot()).workspaces[0]?.lifecycle, "removed");
    await restored.close();
    await writeFile(
      path,
      JSON.stringify({ schemaVersion: 99, projects: [], bindings: [], workspaces: [] }),
    );
    await assert.rejects(() => ProjectCatalog.open(path, target, index));
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 99);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed target unarchive remains denied and explicit retry reconciles target policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-archive-"));
  const target = port();
  const policies: boolean[] = [];
  let failAllow = true;
  target.setArchivePolicy = async (_kind, _id, archived) => {
    policies.push(archived);
    if (!archived && failAllow) throw new Error("target-offline");
  };
  const catalog = await ProjectCatalog.open(join(dir, "catalog.json"), target, index);
  try {
    await catalog.importProject({
      id: "p",
      bindingId: "b",
      name: "A",
      targetId: "local",
      repositoryPath: "/same",
    });
    await catalog.adopt({ bindingId: "b", workspaceId: "w", title: "W", worktreePath: "/same" });
    await catalog.updateWorkspace("w", { archived: true });
    await assert.rejects(catalog.updateWorkspace("w", { archived: false }), /target-offline/);
    assert.equal((await catalog.workspace("w"))?.archived, false);
    failAllow = false;
    await catalog.updateWorkspace("w", { archived: false });
    assert.deepEqual(policies, [true, false, false]);
  } finally {
    await catalog.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("same path different targets independent; complete index hidden waiting and stale freshness, no focus commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-test-"));
  const target = port();
  let onIndexChange: (() => void) | undefined;
  const source = {
    onChange(listener: () => void) {
      onIndexChange = listener;
      return () => {
        onIndexChange = undefined;
      };
    },
    async allSessions() {
      return hierarchyFixture.sessions;
    },
    async workspaceFreshness(w: typeof original) {
      return w.id === "w1" ? ("stale" as const) : ("offline" as const);
    },
  };
  try {
    const catalog = await ProjectCatalog.open(join(dir, "catalog.json"), target, source);
    for (const [projectId, targetId] of [
      ["p1", "local"],
      ["p2", "ssh-a"],
    ])
      await catalog.importProject({
        id: projectId!,
        bindingId: `b${projectId![1]}`,
        name: projectId!,
        targetId: targetId!,
        repositoryPath: "/same",
      });
    for (const [bindingId, workspaceId] of [
      ["b1", "w1"],
      ["b2", "w3"],
    ])
      await catalog.adopt({
        bindingId: bindingId!,
        workspaceId: workspaceId!,
        title: "Main",
        worktreePath: "/same",
      });
    await catalog.updateWorkspace("w1", { hidden: true });
    const snapshot = await catalog.sidebarSnapshot();
    assert.equal(snapshot.workspaceSummaries[0]?.totalAgents, 3);
    assert.equal(snapshot.workspaceSummaries[0]?.freshness, "stale");
    assert.deepEqual(snapshot.projectSummaries[0]?.attentionSessionIds, ["s1"]);
    assert.equal(snapshot.workspaceSummaries[1]?.totalAgents, 0);
    const seen: number[] = [];
    catalog.onChange((revision) => seen.push(revision));
    onIndexChange?.();
    assert.equal((await catalog.sidebarSnapshot()).revision, snapshot.revision! + 1);
    assert.deepEqual(seen, [catalog.revision]);
    assert.notEqual(
      snapshot.workspaces[0]?.workspaceIdentity,
      snapshot.workspaces[1]?.workspaceIdentity,
    );
    assert.deepEqual(target.calls, ["inspect", "inspect", "adopt", "adopt"]);
    await catalog.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration full persistent export dry-run, backup, retry, rollback and future version refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "catalog-migration-"));
  const sidecar = join(dir, "mapping.json");
  const modelBinding = {
    kind: "host-managed" as const,
    selection: { providerId: "p", modelId: "m" },
  };
  const source = {
    sourceSchemaVersion: 1,
    profileId: "profile-1",
    revision: "revision-1",
    checksum: "checksum-1",
    records: [
      {
        id: "s1",
        nativeSessionId: "native-1",
        targetId: "local",
        workspaceIdentity: "local-main",
        workspacePath: "/repo/src",
        cwdRelativeToWorktree: "src",
        harnessId: "zcode",
        modelBinding,
      },
      {
        id: "s2",
        nativeSessionId: "native-2",
        targetId: "ssh",
        workspaceIdentity: "remote:offline",
        workspacePath: "/repo",
        cwdRelativeToWorktree: ".",
        harnessId: "unknown",
        modelBinding,
      },
      { id: "s3", nativeSessionId: "native-3", workspacePath: "/unknown", modelBinding },
    ],
  };
  const backup = {
    sourceSchemaVersion: source.sourceSchemaVersion,
    profileId: source.profileId,
    revision: source.revision,
    checksum: source.checksum,
    backupId: "native-backup-1",
  };
  let backups = 0;
  let verified = true;
  let changeDuringBackup = false;
  let failures = 0;
  const reader = {
    async exportAll() {
      return source;
    },
    async backup() {
      backups++;
      if (changeDuringBackup) source.revision = "revision-2";
      return backup;
    },
    async verifyBackup() {
      return verified;
    },
  };
  try {
    const migration = await LegacyWorkspaceMigration.open(sidecar, reader, {
      async resolve(record) {
        if (record.id === "s2") {
          failures++;
          throw new Error("offline");
        }
        return { binding: hierarchyFixture.bindings[0]!, workspace: original };
      },
    });
    const preview = await migration.dryRun();
    assert.deepEqual(preview.pending, [
      { legacyId: "s2", reason: "offline" },
      { legacyId: "s3", reason: "missing-native-metadata" },
    ]);
    assert.equal(preview.mapped[0]?.nativeSessionId, "native-1");
    assert.equal(preview.mapped[0]?.cwdRelativeToWorktree, "src");
    await assert.rejects(() => readFile(sidecar));
    verified = false;
    await assert.rejects(() => migration.apply(), /unverified-native-backup/);
    await assert.rejects(() => readFile(sidecar));
    verified = true;
    changeDuringBackup = true;
    await assert.rejects(() => migration.apply(), /legacy-index-changed/);
    await assert.rejects(() => readFile(sidecar));
    source.revision = "revision-1";
    changeDuringBackup = false;
    await migration.apply();
    await migration.apply();
    const record = JSON.parse(await readFile(sidecar, "utf8"));
    assert.equal(record.mappings.length, 1);
    assert.deepEqual(record.source, backup);
    assert.equal(backups, 3); // successful retry reuses verified backup
    assert.equal(failures, 5);
    verified = false;
    await assert.rejects(() => migration.rollback(), /unverified-native-backup/);
    verified = true;
    await migration.rollback();
    await assert.rejects(() => readFile(sidecar));
    await migration.close();
    await writeFile(sidecar, JSON.stringify({ schemaVersion: 99 }));
    await assert.rejects(() =>
      LegacyWorkspaceMigration.open(sidecar, reader, {
        async resolve() {
          return undefined;
        },
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
