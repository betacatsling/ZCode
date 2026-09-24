import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProjectCatalog } from "../src/project-workspaces/projectCatalog.js";
import { ProjectCatalogTargetBridge } from "../src/project-workspaces/targetBridge.js";
import { TargetWorktreeService } from "../src/project-workspaces/worktreeService.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const index = {
  async allSessions() {
    return [];
  },
  async workspaceFreshness() {
    return "live" as const;
  },
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "target-receipts-"));
  const main = path.join(root, "main");
  await mkdir(main);
  git(main, "init", "-q");
  git(
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  const targetOptions = {
    storageDirectory: path.join(root, "target"),
    executionTargetId: "local",
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  };
  const open = () => TargetWorktreeService.open(targetOptions);
  const bridge = (target: TargetWorktreeService) =>
    new ProjectCatalogTargetBridge(target, "local", (_id, cwd) => cwd);
  const catalogPath = path.join(root, "catalog.json");
  return { root, main, open, bridge, catalogPath };
}

test("registered binding receipt reconciles the original Catalog import after profile failure", async () => {
  const f = await fixture();
  let target = await f.open();
  let bridge = f.bridge(target);
  let catalog = await ProjectCatalog.open(f.catalogPath, bridge, index);
  try {
    const register = bridge.registerBinding.bind(bridge);
    bridge.registerBinding = async (binding, repositoryPath) => {
      await register(binding, repositoryPath);
      throw new Error("lost catalog binding commit");
    };
    await assert.rejects(
      catalog.importProject({
        id: "p",
        bindingId: "b",
        name: "Project",
        targetId: "local",
        repositoryPath: f.main,
      }),
      /lost catalog/,
    );
    await catalog.close();
    await target.close();
    target = await f.open();
    bridge = f.bridge(target);
    catalog = await ProjectCatalog.open(f.catalogPath, bridge, index);
    assert.equal((await bridge.lookupBinding("b"))?.projectId, "p");
    await catalog.reconcilePending();
    assert.equal((await catalog.binding("b"))?.id, "b");
  } finally {
    await catalog.close().catch(() => undefined);
    await target.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("real Git success then Catalog write failure: target receipt survives restart and reconciles exact original ID", async () => {
  const f = await fixture();
  let target = await f.open();
  let bridge = f.bridge(target);
  let catalog = await ProjectCatalog.open(f.catalogPath, bridge, index);
  try {
    await catalog.importProject({
      id: "p",
      bindingId: "b",
      name: "Project",
      targetId: "local",
      repositoryPath: f.main,
    });
    assert.equal((await bridge.lookupBinding("b"))?.projectId, "p");
    const originalCreate = bridge.create.bind(bridge);
    bridge.create = async (request) => {
      await originalCreate(request);
      throw new Error("simulated catalog writer crash after Git and receipt commit");
    };
    const linked = path.join(f.root, "linked");
    await assert.rejects(
      catalog.create({
        bindingId: "b",
        workspaceId: "w",
        title: "Feature",
        worktreePath: linked,
        branch: "feature",
        baseRef: "HEAD",
      }),
      /simulated/,
    );
    assert.equal((await catalog.sidebarSnapshot()).workspaces.length, 0);
    assert.equal((await bridge.lookupWorkspace("w"))?.title, "Feature");
    assert.equal((await bridge.lookupWorkspace("w"))?.origin, "created");
    await catalog.close();
    await target.close();
    target = await f.open();
    bridge = f.bridge(target);
    catalog = await ProjectCatalog.open(f.catalogPath, bridge, index);
    const recovered = await bridge.lookupWorkspace("w");
    assert.ok(recovered);
    await catalog.reconcilePending();
    assert.deepEqual(await catalog.workspace("w"), recovered);
    assert.equal(git(f.main, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
    await assert.rejects(
      bridge.create({
        binding: (await catalog.binding("b"))!,
        workspaceId: "w",
        title: "Changed",
        sortOrder: 0,
        worktreePath: linked,
        branch: "feature",
        baseRef: "HEAD",
      }),
      /conflicting/,
    );
    assert.deepEqual(await bridge.lookupWorkspace("w"), recovered);
  } finally {
    await catalog.close().catch(() => undefined);
    await target.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("uncertain real Git effect cannot be replayed or adopted from same path and branch", async () => {
  const f = await fixture();
  let target = await TargetWorktreeService.open({
    storageDirectory: path.join(f.root, "target"),
    executionTargetId: "local",
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
    afterGitCreate: async () => {
      throw new Error("crash-before-target-result");
    },
  });
  let bridge = f.bridge(target);
  try {
    const inspected = await bridge.inspectRepository({ targetId: "local", path: f.main });
    const binding = { schemaVersion: 1 as const, id: "b", projectId: "p", ...inspected };
    await bridge.registerBinding(binding, f.main);
    const request = {
      binding,
      workspaceId: "w",
      title: "Feature",
      sortOrder: 0,
      worktreePath: path.join(f.root, "linked"),
      branch: "feature",
      baseRef: "HEAD",
    };
    await assert.rejects(bridge.create(request), /crash-before-target-result/);
    await target.close();
    target = await f.open();
    bridge = f.bridge(target);
    await assert.rejects(bridge.lookupWorkspace("w"), /unknown/);
    await assert.rejects(bridge.create(request), /unknown/);
    assert.equal(git(f.main, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 2);
    await assert.rejects(
      bridge.adopt({
        binding,
        workspaceId: "other",
        title: "Unreviewed",
        sortOrder: 0,
        worktreePath: request.worktreePath,
      }),
      /pending|reserved/,
    );
  } finally {
    await target.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("real Git remove with failed Catalog commit resolves the removed receipt after restart", async () => {
  const f = await fixture();
  let target = await f.open();
  let bridge = f.bridge(target);
  let catalog = await ProjectCatalog.open(f.catalogPath, bridge, index);
  try {
    await catalog.importProject({
      id: "p",
      bindingId: "b",
      name: "Project",
      targetId: "local",
      repositoryPath: f.main,
    });
    const workspace = await catalog.create({
      bindingId: "b",
      workspaceId: "w",
      title: "Feature",
      worktreePath: path.join(f.root, "linked"),
      branch: "feature",
      baseRef: "HEAD",
    });
    const originalRemove = bridge.remove.bind(bridge);
    bridge.remove = async (request) => {
      await originalRemove(request);
      throw new Error("simulated lost profile commit");
    };
    await assert.rejects(
      catalog.remove({
        workspaceId: "w",
        expectedGeneration: workspace.worktreeGeneration,
        confirmation: true,
      }),
      /simulated/,
    );
    await catalog.close();
    await target.close();
    target = await f.open();
    bridge = f.bridge(target);
    catalog = await ProjectCatalog.open(f.catalogPath, bridge, index);
    assert.equal((await bridge.lookupWorkspace("w"))?.lifecycle, "removed");
    await catalog.reconcilePending();
    assert.equal((await catalog.workspace("w"))?.lifecycle, "removed");
    assert.equal(git(f.main, "worktree", "list", "--porcelain").match(/worktree /g)?.length, 1);
  } finally {
    await catalog.close().catch(() => undefined);
    await target.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("invalid adoption before instance mutation does not poison the stable ID", async () => {
  const f = await fixture();
  const target = await f.open();
  const bridge = f.bridge(target);
  try {
    const inspected = await bridge.inspectRepository({ targetId: "local", path: f.main });
    const binding = { schemaVersion: 1 as const, id: "b", projectId: "p", ...inspected };
    await bridge.registerBinding(binding, f.main);
    const request = {
      binding,
      workspaceId: "w",
      title: "Main",
      sortOrder: 0,
      worktreePath: f.main,
    };
    const invalid = { ...request, worktreePath: path.join(f.root, "missing") };
    await assert.rejects(bridge.adopt(invalid));
    assert.equal(await bridge.lookupWorkspace("w"), undefined);
    assert.equal((await bridge.adopt(request)).id, "w");
    assert.equal((await bridge.adopt(request)).id, "w");
  } finally {
    await target.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("rebuilt same path and branch never becomes old successful receipt", async () => {
  const f = await fixture();
  const target = await f.open();
  const bridge = f.bridge(target);
  try {
    const inspected = await bridge.inspectRepository({ targetId: "local", path: f.main });
    const binding = { schemaVersion: 1 as const, id: "b", projectId: "p", ...inspected };
    await bridge.registerBinding(binding, f.main);
    const request = {
      binding,
      workspaceId: "w",
      title: "Feature",
      sortOrder: 0,
      worktreePath: path.join(f.root, "linked"),
      branch: "feature",
      baseRef: "HEAD",
    };
    await bridge.create(request);
    git(f.main, "worktree", "remove", "--force", request.worktreePath);
    git(f.main, "worktree", "add", "-q", request.worktreePath, "feature");
    await assert.rejects(bridge.lookupWorkspace("w"), /instance|reconciliation/);
    await assert.rejects(bridge.create(request), /instance|reconciliation/);
  } finally {
    await target.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});
