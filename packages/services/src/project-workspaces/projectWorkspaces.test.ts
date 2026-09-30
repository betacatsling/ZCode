import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProjectWorkspaces } from "./index.js";
import { parsePorcelainZ } from "./porcelain.js";
import { resolveRepositoryBinding } from "./repositoryBindingResolver.js";
import { sameWorkspaceIdentity, workspaceIdentityKey } from "./identity.js";
import { createFileCatalogStore, createMemoryCatalogStore } from "./store.js";
import {
  assertCode,
  createWorkspaceWorld,
  encodePorcelain,
} from "./projectWorkspaces.test-support.js";
import type { CreateAgentSessionInput } from "./sessions.js";

function repoWorld() {
  const world = createWorkspaceWorld({
    "/repo": { device: 1, inode: 1 },
    "/repo/.git": { device: 1, inode: 2 },
    "/repo-a": { device: 1, inode: 3 },
    "/repo-a/src": { device: 1, inode: 6 },
    "/repo-b": { device: 1, inode: 4 },
    "/repo/src": { device: 1, inode: 5 },
    "/repo/link": { device: 9, inode: 9, real: "/outside" },
    "/outside": { device: 9, inode: 9 },
    "/repo/feature": { device: 4, inode: 8 },
  });
  delete world.entries["/repo/feature"];
  world.records.push(
    { path: "/repo", oid: "aaa111", branch: "develop" },
    { path: "/repo-a", oid: "bbb222", branch: "main" },
    { path: "/repo-b", oid: "ccc333", branch: "feature/other" },
  );
  return world;
}

function runtimeFor(world: ReturnType<typeof repoWorld>, executionTargetId = "host-a") {
  return createProjectWorkspaces({
    executionTargetId,
    git: world.git,
    filesystem: world.filesystem,
    activity: world.activityPort,
    idFactory: world.idFactory,
    knownHarnessIds: ["pi", "zcode", "codex"],
  });
}

test("身份键裁剪 workspaceIdentity，路径不裁剪，且不能只按路径跨目标匹配", () => {
  assert.equal(
    workspaceIdentityKey({ workspaceIdentity: "  remote-1  ", workspacePath: "/repo" }),
    "remote-1",
  );
  assert.equal(
    workspaceIdentityKey({ workspaceIdentity: "   ", workspacePath: " /repo" }),
    " /repo",
  );
  assert.equal(
    sameWorkspaceIdentity(
      { executionTargetId: "host-a", workspacePath: "/repo", workspaceIdentity: "remote-1" },
      { executionTargetId: "host-a", workspacePath: "/repo", workspaceIdentity: "remote-2" },
    ),
    false,
  );
  assert.equal(
    sameWorkspaceIdentity(
      { executionTargetId: "host-a", workspacePath: "/repo" },
      { executionTargetId: "host-b", workspacePath: "/repo" },
    ),
    false,
  );
  assert.equal(
    sameWorkspaceIdentity(
      { executionTargetId: "host-a", workspacePath: "/repo", workspaceIdentity: "  " },
      { executionTargetId: "host-a", workspacePath: "/repo" },
    ),
    true,
  );
  assert.equal(
    sameWorkspaceIdentity({ workspacePath: "/repo" }, { workspacePath: "/repo" }),
    false,
  );
});

test("porcelain -z 保留带空格的路径，不用空白拆分", () => {
  const stdout = encodePorcelain([
    { path: "/work/my tree", oid: "abcd", branch: "topic/a" },
    { path: "/work/other", oid: "eeee", detached: true },
  ]);
  const records = parsePorcelainZ(stdout);
  assert.equal(records[0]?.path, "/work/my tree");
  assert.deepEqual(records[0]?.head, { kind: "branch", ref: "topic/a", oid: "abcd" });
  assert.equal(records[1]?.head.kind, "detached");
});

test("binding 只按目标和 common dir 合并，origin 相同的两份 clone 不合并", () => {
  const allocateId = (() => {
    let n = 0;
    return () => `b-${++n}`;
  })();
  const first = resolveRepositoryBinding({
    bindings: [],
    projectId: "p1",
    executionTargetId: "host-a",
    gitCommonDir: "/repo/.git",
    originUrl: "git@example.com:repo.git",
    allocateId,
  });
  const otherHost = resolveRepositoryBinding({
    bindings: [first.binding],
    projectId: "p1",
    executionTargetId: "host-b",
    gitCommonDir: "/repo/.git",
    originUrl: "git@example.com:repo.git",
    allocateId,
  });
  const otherClone = resolveRepositoryBinding({
    bindings: [first.binding, otherHost.binding],
    projectId: "p1",
    executionTargetId: "host-a",
    gitCommonDir: "/clone-2/.git",
    originUrl: "git@example.com:repo.git",
    allocateId,
  });
  const again = resolveRepositoryBinding({
    bindings: [first.binding, otherHost.binding, otherClone.binding],
    projectId: "p1",
    executionTargetId: "host-a",
    gitCommonDir: "/repo/.git",
    originUrl: "git@example.com:other.git",
    allocateId,
  });
  assert.equal(otherHost.created, true);
  assert.equal(otherClone.created, true);
  assert.equal(again.created, false);
  assert.equal(again.binding.id, first.binding.id);
  assert.notEqual(first.binding.id, otherHost.binding.id);
  assert.notEqual(first.binding.id, otherClone.binding.id);
});

test("一个项目接管主检出和两个 linked worktree，branch 名不是 id", async () => {
  const world = repoWorld();
  const runtime = runtimeFor(world);
  const before = world.calls.length;
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const discovered = await runtime.worktrees.discover("/repo-a");
  assert.equal(discovered.kind, "git");
  if (discovered.kind !== "git") return;
  assert.equal(discovered.candidates.length, 3);
  assert.equal(
    world.calls.slice(before).some((args) => args.includes("init")),
    false,
  );
  assert.equal(world.mutatingCalls().length, 0);
  const adopted = [];
  for (const candidate of discovered.candidates) {
    adopted.push(
      await runtime.worktrees.adopt({
        projectId: project.id,
        worktreePath: candidate.worktreePath,
      }),
    );
  }
  const workspaces = await runtime.worktrees.listWorkspaces(project.id);
  assert.equal(workspaces.length, 3);
  const main = workspaces.find((workspace) => workspace.isMainWorktree);
  const linkedNamedMain = workspaces.find((workspace) => workspace.worktreePath === "/repo-a");
  assert.equal(main?.head.kind === "branch" && main.head.ref, "develop");
  assert.equal(linkedNamedMain?.isMainWorktree, false);
  assert.equal(linkedNamedMain?.head.kind === "branch" && linkedNamedMain.head.ref, "main");
  for (const workspace of workspaces) {
    assert.notEqual(workspace.id, workspace.head.kind === "branch" ? workspace.head.ref : "");
  }
  const bindings = new Set(
    (await runtime.store.read()).bindings
      .filter((binding) => binding.projectId === project.id)
      .map((binding) => binding.id),
  );
  assert.equal(bindings.size, 1);
  const updated = await runtime.catalog.setDefaultWorkspace(project.id, linkedNamedMain?.id);
  assert.equal(updated.defaultWorkspaceId, linkedNamedMain?.id);
  assert.equal(
    (await runtime.worktrees.listWorkspaces(project.id)).find((item) => item.id === main?.id)
      ?.isMainWorktree,
    true,
  );
});

test("同一工作区新建三个会话不创建 worktree，也不改已有会话", async () => {
  const world = repoWorld();
  const runtime = runtimeFor(world);
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  assert.equal(adopted.status, "adopted");
  if (adopted.status !== "adopted") return;
  const addsBefore = world.calls.filter((args) => args.includes("add")).length;
  const headBefore = adopted.workspace.head;
  const first = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "调研",
    executionTargetId: "evil-host",
  } as CreateAgentSessionInput);
  const second = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "实现",
  });
  const third = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "zcode",
    title: "审阅",
    cwdRelativeToWorktree: "src",
  });
  assert.equal(world.calls.filter((args) => args.includes("add")).length, addsBefore);
  assert.deepEqual((await runtime.worktrees.listWorkspaces())[0]?.head, headBefore);
  assert.equal((await runtime.worktrees.listSessions(adopted.workspace.id)).length, 3);
  assert.equal(first.execution.executionTargetId, "host-a");
  assert.equal(first.execution.worktreePath, second.execution.worktreePath);
  assert.equal(first.execution.worktreeGeneration, third.execution.worktreeGeneration);
  assert.equal(first.session.harnessId, "pi");
  assert.equal(third.execution.cwdRelativeToWorktree, "src");
  assert.equal(runtime.worktrees.describeSharedWorkspace().attributesDiffToSession, false);
  assert.equal(runtime.worktrees.describeSharedWorkspace().gitDiffLabel, "工作区变更");
  const stopped = await runtime.worktrees.stopAgentSession(first.session.id);
  assert.deepEqual(stopped.stoppedSessionIds, [first.session.id]);
  assert.equal(
    (await runtime.worktrees.listSessions(adopted.workspace.id)).some(
      (session) => session.id === second.session.id,
    ),
    true,
  );
  const detached = await runtime.worktrees.noteViewDetached(third.session.id);
  assert.equal(detached.sessionRetained, true);
  assert.equal((await runtime.worktrees.listWorkspaces()).length, 1);
});

test("显式子目录不能经符号链接逃出 worktree", async () => {
  const world = repoWorld();
  const runtime = runtimeFor(world);
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo" });
  if (adopted.status !== "adopted") return;
  await assert.rejects(
    runtime.worktrees.createAgentSession({
      workspaceId: adopted.workspace.id,
      harnessId: "pi",
      title: "逃逸",
      cwdRelativeToWorktree: "link",
    }),
    (error) => assertCode(error, "cwd-escapes-worktree"),
  );
});

test("新建工作区使用独立 argv，目录写入失败时保留未登记候选", async () => {
  const world = repoWorld();
  const memory = createMemoryCatalogStore();
  let failWrites = 0;
  const store = {
    read: () => memory.read(),
    update: async <T>(mutator: Parameters<typeof memory.update<T>>[0]) => {
      if (failWrites > 0) {
        failWrites -= 1;
        throw new Error("catalog-write-failed");
      }
      return memory.update(mutator);
    },
  };
  const runtime = createProjectWorkspaces({
    executionTargetId: "host-a",
    git: world.git,
    filesystem: world.filesystem,
    activity: world.activityPort,
    store,
    idFactory: world.idFactory,
    knownHarnessIds: ["pi"],
  });
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo" });
  if (adopted.status !== "adopted") return;
  await assert.rejects(
    runtime.worktrees.createWorkspace({
      requestId: "req-bad",
      projectId: project.id,
      repositoryBindingId: adopted.binding.id,
      title: "坏分支",
      worktreePath: "/repo/evil",
      mode: "new-branch",
      branch: "main;rm",
      baseRef: "develop",
    }),
    (error) => assertCode(error, "unsafe-ref"),
  );
  world.entries["/repo"] = { device: 1, inode: 1 };
  failWrites = 1;
  const created = await runtime.worktrees.createWorkspace({
    requestId: "req-1",
    projectId: project.id,
    repositoryBindingId: adopted.binding.id,
    title: "隔离",
    worktreePath: "/repo/feature",
    mode: "new-branch",
    branch: "feature/a",
    baseRef: "develop",
  });
  assert.equal(created.status, "unregistered");
  const addCalls = world.calls.filter((args) => args.includes("add"));
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0]?.includes("--force"), false);
  assert.equal(addCalls[0]?.includes("core.hooksPath=/dev/null"), true);
  assert.equal(addCalls[0]?.includes("feature/a"), true);
  assert.equal(
    world.calls.some((args) => args.includes("remove")),
    false,
  );
  assert.equal(
    (await runtime.worktrees.listWorkspaces()).some(
      (workspace) => workspace.worktreePath === "/repo/feature",
    ),
    false,
  );
  const retry = await runtime.worktrees.createWorkspace({
    requestId: "req-2",
    projectId: project.id,
    repositoryBindingId: adopted.binding.id,
    title: "隔离",
    worktreePath: "/repo/feature",
    mode: "new-branch",
    branch: "feature/a",
    baseRef: "develop",
  });
  assert.equal(retry.status, "unregistered");
  assert.equal(world.calls.filter((args) => args.includes("add")).length, 1);
});

test("删除期间拒绝新会话，拒绝路径不先停止会话", async () => {
  const world = repoWorld();
  const runtime = runtimeFor(world);
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  if (adopted.status !== "adopted") return;
  const session = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "保留",
  });
  world.setActivity("busy");
  const rejected = await runtime.worktrees.removeLinkedWorktree({
    workspaceId: adopted.workspace.id,
    expectedGeneration: adopted.workspace.worktreeGeneration,
    acknowledgeRisks: true,
    acknowledgeExternalWriters: true,
    stopConfirmed: false,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(world.stopped.length, 0);
  assert.equal(
    world.calls.some((args) => args.includes("remove")),
    false,
  );
  assert.equal((await runtime.worktrees.listSessions(adopted.workspace.id)).length, 1);

  const main = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo" });
  if (main.status !== "adopted") return;
  const mainRejected = await runtime.worktrees.removeLinkedWorktree({
    workspaceId: main.workspace.id,
    expectedGeneration: main.workspace.worktreeGeneration,
    acknowledgeRisks: true,
    acknowledgeExternalWriters: true,
    stopConfirmed: true,
  });
  assert.equal(mainRejected.status, "rejected");
  if (mainRejected.status === "rejected")
    assert.equal(mainRejected.reasons.includes("main-worktree"), true);

  world.setActivity("idle");
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
  world.releaseRemove();
  const removed = await removal;
  assert.equal(removed.status, "removed");
  assert.equal(
    (await runtime.worktrees.listSessions(adopted.workspace.id))[0]?.id,
    session.session.id,
  );
  await assert.rejects(
    runtime.worktrees.createAgentSession({
      workspaceId: adopted.workspace.id,
      harnessId: "pi",
      title: "已移除",
    }),
    (error) => assertCode(error, "workspace-removed"),
  );
  world.entries["/repo-a"] = { device: 8, inode: 80 };
  world.records.push({ path: "/repo-a", oid: "fff444", branch: "rebuilt" });
  const retaken = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  assert.equal(retaken.status, "adopted");
  if (retaken.status !== "adopted") return;
  assert.notEqual(retaken.workspace.id, adopted.workspace.id);
  assert.equal(
    (await runtime.worktrees.readExecution(session.session.id)).workspaceId,
    adopted.workspace.id,
  );
});

test("扫描失败不清空目录；同实例改名更新，路径重建则待核实", async () => {
  const world = repoWorld();
  const runtime = runtimeFor(world);
  const project = await runtime.catalog.createProject({ name: "Repo" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-b" });
  if (adopted.status !== "adopted") return;
  const session = await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "历史",
  });
  world.setFailList("timeout");
  const failed = await runtime.reconciler.refresh("/repo-b");
  assert.equal(failed.freshness, "stale");
  assert.equal(failed.unadoptedCount, null);
  assert.equal((await runtime.worktrees.listWorkspaces())[0]?.lifecycle, "active");
  world.setFailList("unknown-z");
  const upgrade = await runtime.worktrees.discover("/repo-b");
  assert.equal(upgrade.kind, "upgrade-required");
  assert.equal((await runtime.worktrees.listWorkspaces())[0]?.lifecycle, "active");

  world.setFailList(null);
  world.records[2] = { path: "/repo-b", oid: "ccc333", branch: "renamed" };
  const renamed = await runtime.reconciler.refresh("/repo-b");
  assert.equal(renamed.updatedIds.includes(adopted.workspace.id), true);
  const afterRename = await runtime.worktrees.listWorkspaces();
  assert.equal(afterRename[0]?.id, adopted.workspace.id);
  assert.equal(afterRename[0]?.head.kind === "branch" && afterRename[0].head.ref, "renamed");
  assert.equal(
    (await runtime.worktrees.readExecution(session.session.id)).workspaceId,
    adopted.workspace.id,
  );

  world.entries["/repo-b"] = { device: 1, inode: 99 };
  const rebuilt = await runtime.reconciler.refresh("/repo-b");
  assert.equal(rebuilt.needsVerificationIds.includes(adopted.workspace.id), true);
  await assert.rejects(
    runtime.worktrees.createAgentSession({
      workspaceId: adopted.workspace.id,
      harnessId: "pi",
      title: "不能进新目录",
    }),
    (error) => assertCode(error, "needs-verification"),
  );
  const explicit = await runtime.worktrees.adopt({
    projectId: project.id,
    worktreePath: "/repo-b",
    title: "重建",
  });
  assert.equal(explicit.status, "adopted");
  if (explicit.status !== "adopted") return;
  assert.notEqual(explicit.workspace.id, adopted.workspace.id);
  assert.equal(
    (await runtime.worktrees.readExecution(session.session.id)).workspaceId,
    adopted.workspace.id,
  );
});

test("非 Git 与 bare 仓库不制造可执行主检出", async () => {
  const world = repoWorld();
  world.setNotGit(true);
  const runtime = runtimeFor(world);
  const folder = await runtime.worktrees.discover("/repo");
  assert.equal(folder.kind, "folder");
  if (folder.kind === "folder") assert.equal(folder.plainFolder, true);
  assert.equal(
    world.calls.some((args) => args.includes("init")),
    false,
  );

  const bareWorld = createWorkspaceWorld({
    "/repos/app.git": { device: 2, inode: 1 },
  });
  bareWorld.setBare(true);
  bareWorld.setCommonDir("/repos/app.git");
  bareWorld.records.push({ path: "/repos/app.git", oid: "abc123", bare: true });
  const bareRuntime = runtimeFor(bareWorld, "host-a");
  const bare = await bareRuntime.worktrees.discover("/repos/app.git");
  assert.equal(bare.kind, "bare");
  if (bare.kind !== "bare") return;
  assert.equal(bare.needsWorkspace, true);
  assert.equal(bare.candidates.length, 0);
  const project = await bareRuntime.catalog.createProject({ name: "Bare" });
  const binding = await bareRuntime.worktrees.adoptBare({
    projectId: project.id,
    inputPath: "/repos/app.git",
  });
  assert.equal(binding.gitCommonDir, "/repos/app.git");
  assert.equal((await bareRuntime.worktrees.listWorkspaces()).length, 0);
});

test("归档、隐藏和从应用移除都不删除目录或会话", async () => {
  const world = repoWorld();
  const runtime = runtimeFor(world);
  const project = await runtime.catalog.createProject({ name: "Repo", iconAssetId: "icon-1" });
  const adopted = await runtime.worktrees.adopt({ projectId: project.id, worktreePath: "/repo-a" });
  if (adopted.status !== "adopted") return;
  await runtime.worktrees.createAgentSession({
    workspaceId: adopted.workspace.id,
    harnessId: "pi",
    title: "还在",
  });
  const removesBefore = world.calls.filter((args) => args.includes("remove")).length;
  await runtime.worktrees.setHidden(adopted.workspace.id, true);
  await runtime.worktrees.archiveWorkspace(adopted.workspace.id);
  assert.equal(world.stopped.length, 0);
  await assert.rejects(
    runtime.worktrees.createAgentSession({
      workspaceId: adopted.workspace.id,
      harnessId: "pi",
      title: "归档后",
    }),
    (error) => assertCode(error, "workspace-archived"),
  );
  assert.equal((await runtime.worktrees.listSessions(adopted.workspace.id)).length, 1);
  await runtime.catalog.removeFromApp(project.id);
  assert.equal((await runtime.catalog.listProjects()).length, 0);
  assert.equal((await runtime.catalog.readProject(project.id))?.removedFromApp, true);
  assert.equal((await runtime.worktrees.listWorkspaces()).length, 1);
  assert.equal(world.calls.filter((args) => args.includes("remove")).length, removesBefore);
});

test("目录存储拒绝未知 schema，内存更新失败不留下半份状态", async () => {
  const memory = createMemoryCatalogStore();
  await assert.rejects(
    memory.update(() => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal((await memory.read()).projects.length, 0);

  const directory = await mkdtemp(join(tmpdir(), "project-workspaces-"));
  const filePath = join(directory, "catalog.json");
  const original = JSON.stringify({ schemaVersion: 2, projects: [] });
  await writeFile(filePath, original, "utf8");
  const store = createFileCatalogStore(filePath);
  await assert.rejects(store.read(), (error) => assertCode(error, "unsupported-schema"));
  assert.equal(await readFile(filePath, "utf8"), original);
});
