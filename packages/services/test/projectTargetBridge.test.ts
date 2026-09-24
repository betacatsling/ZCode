import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { ProjectCatalog } from "../src/project-workspaces/projectCatalog.js";
import {
  CatalogWorkspaceAdmission,
  ProjectCatalogTargetBridge,
} from "../src/project-workspaces/targetBridge.js";
import { TargetWorktreeService } from "../src/project-workspaces/worktreeService.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
async function repo(root: string, name: string, commit = true) {
  const dir = path.join(root, name);
  await mkdir(dir);
  git(dir, "init", "-q");
  if (commit)
    git(
      dir,
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
  return dir;
}
const index = {
  async allSessions() {
    return [];
  },
  async workspaceFreshness() {
    return "live" as const;
  },
};

test("real Git catalog+target+Host admission, archive denial and removal preview", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "target-bridge-"));
  const main = await repo(dir, "main");
  let offline = false;
  const target = await TargetWorktreeService.open({
    storageDirectory: path.join(dir, "target"),
    executionTargetId: "local",
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline }),
  });
  let catalog!: ProjectCatalog;
  const bridge = new ProjectCatalogTargetBridge(target, "local", (_id, cwd) => cwd);
  try {
    catalog = await ProjectCatalog.open(path.join(dir, "catalog.json"), bridge, index);
    await catalog.importProject({
      id: "p",
      bindingId: "b",
      name: "Project",
      targetId: "local",
      repositoryPath: main,
    });
    const discovered = await catalog.discover("b");
    assert.equal(discovered.length, 1);
    assert.equal((await catalog.sidebarSnapshot()).workspaces.length, 0);
    const mainWorkspace = await catalog.adopt({
      bindingId: "b",
      workspaceId: "main",
      title: "Main",
      worktreePath: main,
    });
    const linked = path.join(dir, "linked");
    const workspace = await catalog.create({
      bindingId: "b",
      workspaceId: "w",
      title: "Feature",
      worktreePath: linked,
      baseRef: "HEAD",
      branch: "feature",
    });
    assert.equal(await realpath(workspace.worktreePath), await realpath(linked));
    const admission = new CatalogWorkspaceAdmission(catalog, target, "local");
    const spec: SessionSpecV2 = {
      schemaVersion: 2,
      hostSessionId: "s",
      projectId: "p",
      workspaceId: "w",
      execution: {
        targetId: "local",
        workspaceIdentity: workspace.workspaceIdentity,
        worktreePath: workspace.worktreePath,
        worktreeGeneration: workspace.worktreeGeneration,
        cwdRelativeToWorktree: ".",
      },
      harness: { id: "pi", adapterVersion: "v1" },
      modelBinding: { kind: "harness-managed" },
    };
    let hostCalls = 0;
    const host = () =>
      admission.withAdmission(spec, async (cwd) => {
        hostCalls++;
        return cwd;
      });
    assert.equal(await host(), await realpath(linked));
    await assert.rejects(
      admission.verify({
        ...spec,
        execution: { ...spec.execution, workspaceIdentity: "untrusted" },
      }),
      /scope/,
    );
    await assert.rejects(
      admission.verify({
        ...spec,
        execution: { ...spec.execution, worktreeGeneration: mainWorkspace.worktreeGeneration },
      }),
      /scope/,
    );
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const admitted = admission.withAdmission(spec, async () => {
      entered();
      await pending;
    });
    await ready;
    let acknowledged = false;
    const archive = catalog.updateProject("p", { archived: true }).then(() => {
      acknowledged = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(acknowledged, false); // the target policy cannot pass an active Host gate
    release();
    await admitted;
    await archive;
    await assert.rejects(host(), /scope|archived/);
    await assert.rejects(
      catalog.create({
        bindingId: "b",
        workspaceId: "x",
        title: "No",
        worktreePath: path.join(dir, "new"),
        baseRef: "HEAD",
        branch: "new",
      }),
      /archived/,
    );
    await catalog.updateProject("p", { archived: false });
    assert.equal(await host(), await realpath(linked));
    await catalog.updateWorkspace("w", { archived: true });
    await assert.rejects(host(), /scope|archived/);
    await catalog.updateWorkspace("w", { archived: false });
    assert.equal(hostCalls, 2);
    await writeFile(path.join(linked, "untracked"), "data");
    assert.equal(
      (await catalog.previewRemoval("w", workspace.worktreeGeneration)).git?.untracked,
      true,
    );
    await assert.rejects(
      catalog.remove({
        workspaceId: "w",
        expectedGeneration: workspace.worktreeGeneration,
        confirmation: true,
      }),
      /preview/,
    );
    await rm(path.join(linked, "untracked"));
    offline = true;
    assert.equal((await catalog.previewRemoval("w", workspace.worktreeGeneration)).unknown, true);
    offline = false;
    assert.equal((await catalog.previewRemoval("w", workspace.worktreeGeneration)).safe, true);
    await catalog.remove({
      workspaceId: "w",
      expectedGeneration: workspace.worktreeGeneration,
      confirmation: true,
    });
    assert.equal(target.history("w")?.lifecycle, "removed");
    assert.ok(git(main, "show-ref", "--verify", "refs/heads/feature"));
    assert.equal(
      (await catalog.sidebarSnapshot()).workspaces.find((w) => w.id === "w")?.lifecycle,
      "removed",
    );
    await assert.rejects(host());
    await target.close();
    await assert.rejects(catalog.updateProject("p", { archived: true }), /closed/);
    assert.equal((await catalog.project("p"))?.archived, false);
    await catalog.close();
  } finally {
    await target.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unborn main is discoverable/adoptable and bare repository has no runnable candidate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "target-bridge-"));
  const unborn = await repo(dir, "empty", false);
  const bare = path.join(dir, "bare.git");
  git(unborn, "init", "--bare", "-q", bare);
  const target = await TargetWorktreeService.open({
    storageDirectory: path.join(dir, "target"),
    executionTargetId: "local",
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  let catalog!: ProjectCatalog;
  const bridge = new ProjectCatalogTargetBridge(target, "local", (_id, cwd) => cwd);
  try {
    catalog = await ProjectCatalog.open(path.join(dir, "catalog.json"), bridge, index);
    await catalog.importProject({
      id: "p",
      bindingId: "b",
      name: "Empty",
      targetId: "local",
      repositoryPath: unborn,
    });
    const candidate = (await catalog.discover("b"))[0]!;
    assert.equal(candidate.head.kind, "branch");
    if (candidate.head.kind === "branch") assert.equal(candidate.head.oid, null);
    const adopted = await catalog.adopt({
      bindingId: "b",
      workspaceId: "w",
      title: "Unborn",
      worktreePath: unborn,
    });
    assert.equal(adopted.isMainWorktree, true);
    await catalog.importProject({
      id: "bare",
      bindingId: "bare-binding",
      name: "Bare",
      targetId: "local",
      repositoryPath: bare,
    });
    assert.deepEqual(await catalog.discover("bare-binding"), []);
    await catalog.close();
  } finally {
    await target.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("linked path dedups same instance; rebuilt same path has distinct binding", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "target-bridge-"));
  const main = await repo(dir, "main");
  const target = await TargetWorktreeService.open({
    storageDirectory: path.join(dir, "state"),
    executionTargetId: "local",
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  let catalog!: ProjectCatalog;
  const bridge = new ProjectCatalogTargetBridge(target, "local", (_id, cwd) => cwd);
  try {
    catalog = await ProjectCatalog.open(path.join(dir, "catalog.json"), bridge, index);
    await catalog.importProject({
      id: "p1",
      bindingId: "b1",
      name: "Old",
      targetId: "local",
      repositoryPath: main,
    });
    const linked = path.join(dir, "linked");
    git(main, "worktree", "add", "-q", "-b", "feature", linked);
    await assert.rejects(
      catalog.importProject({
        id: "duplicate",
        bindingId: "duplicate",
        name: "Duplicate",
        targetId: "local",
        repositoryPath: linked,
      }),
      /already-imported/,
    );
    await rm(linked, { recursive: true });
    await rm(main, { recursive: true });
    await repo(dir, "main");
    await catalog.importProject({
      id: "p2",
      bindingId: "b2",
      name: "Rebuilt",
      targetId: "local",
      repositoryPath: main,
    });
    assert.equal((await catalog.sidebarSnapshot()).bindings.length, 2);
    assert.equal(await target.matchesBinding("b1", main), false);
    assert.equal((await target.reconcile("b1")).status, "scanFailed");
    assert.equal(target.bindings().find((binding) => binding.id === "b1")?.projectId, "p1");
    assert.equal(await target.matchesBinding("b2", main), true);
    await catalog.close();
  } finally {
    await target.close();
    await rm(dir, { recursive: true, force: true });
  }
});
