import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openTargetWorktreeService } from "../src/project-workspaces/worktreeService.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zcode-target-worktree-"));
  const main = path.join(dir, "main");
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
  const storageDirectory = path.join(dir, "state");
  const activity = async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false });
  const service = await openTargetWorktreeService({
    storageDirectory,
    executionTargetId: "local-a",
    activity,
  });
  const binding = await service.registerBinding({
    id: "b",
    executionTargetId: "local-a",
    repositoryPath: main,
  });
  return { dir, main, service, binding, storageDirectory, activity };
}

test("target namespace and actual Git administrative instance fence admission", async () => {
  const f = await fixture();
  try {
    const mainRecord = await f.service.adopt({
      bindingId: "b",
      workspaceId: "main",
      worktreePath: f.main,
    });
    const linkedPath = path.join(f.dir, "linked");
    const linked = await f.service.create({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: linkedPath,
      branch: "feature",
      mode: "new",
      baseRef: "HEAD",
    });
    await mkdir(path.join(linkedPath, "sub"));
    assert.equal(
      await f.service.verify("w", linked.generation, "sub"),
      await realpath(path.join(linkedPath, "sub")),
    );
    await symlink(f.main, path.join(linkedPath, "escape"));
    await assert.rejects(f.service.verify("w", linked.generation, "escape"));
    git(linkedPath, "init", "-q", "sub/nested");
    await assert.rejects(f.service.verify("w", linked.generation, "sub/nested"));
    await assert.rejects(
      f.service.registerBinding({
        id: "other",
        executionTargetId: "local-b",
        repositoryPath: f.main,
      }),
    );
    await assert.rejects(f.service.remove("main", mainRecord.generation, true));
    await f.service.close();
    git(f.main, "worktree", "remove", "--force", linkedPath);
    git(f.main, "worktree", "add", "-q", "--detach", linkedPath, "HEAD");
    const reopened = await openTargetWorktreeService({
      storageDirectory: f.storageDirectory,
      executionTargetId: "local-a",
      activity: f.activity,
    });
    try {
      await assert.rejects(reopened.verify("w", linked.generation, "."));
      assert.equal(reopened.history("w")?.lifecycle, "needsVerification");
    } finally {
      await reopened.close();
    }
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("remove freezes admission, rejects busy/dirty, and preserves branch/history", async () => {
  const f = await fixture();
  try {
    const linkedPath = path.join(f.dir, "linked");
    const record = await f.service.create({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: linkedPath,
      branch: "feature",
      mode: "new",
      baseRef: "HEAD",
    });
    await writeFile(path.join(linkedPath, "dirty"), "data");
    await assert.rejects(f.service.remove("w", record.generation, true));
    await rm(path.join(linkedPath, "dirty"));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const admitted = f.service.withAdmission("w", record.generation, async () => {
      entered();
      await pending;
    });
    await ready;
    const removal = f.service.remove("w", record.generation, true);
    const competingCreate = f.service
      .withAdmission("w", record.generation, async () => {
        throw new Error("create callback must not run after removal request");
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    release();
    await admitted;
    await removal;
    assert.match(String(await competingCreate), /generation is not admitted|admission frozen/);
    assert.equal(f.service.history("w")?.lifecycle, "removed");
    assert.equal(git(f.main, "show-ref", "--verify", "refs/heads/feature").length > 0, true);
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("different execution targets at the same physical path cannot share binding records", async () => {
  const f = await fixture();
  const other = await openTargetWorktreeService({
    storageDirectory: f.storageDirectory,
    executionTargetId: "local-b",
    activity: f.activity,
  });
  try {
    assert.deepEqual(other.bindings(), []);
    const b = await other.registerBinding({
      id: "b",
      executionTargetId: "local-b",
      repositoryPath: f.main,
    });
    assert.equal(b.executionTargetId, "local-b");
    const a = await f.service.adopt({
      bindingId: "b",
      workspaceId: "shared",
      worktreePath: f.main,
    });
    const c = await other.adopt({ bindingId: "b", workspaceId: "shared", worktreePath: f.main });
    assert.notEqual(a.generation, c.generation);
  } finally {
    await other.close();
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("catalog failure after Git creation leaves a recoverable target record", async () => {
  const f = await fixture();
  try {
    const linkedPath = path.join(f.dir, "linked");
    const created = await f.service.create({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: linkedPath,
      branch: "feature",
      mode: "new",
      baseRef: "HEAD",
    });
    // 模拟目标登记后 Catalog 写入失败：不能把未展示的目标事实当作已删除。
    const catalogWorkspaceIds = new Set<string>();
    await f.service.close();
    const restarted = await openTargetWorktreeService({
      storageDirectory: f.storageDirectory,
      executionTargetId: "local-a",
      activity: f.activity,
    });
    try {
      const result = await restarted.reconcile("b");
      assert.equal(result.status, "ok");
      if (result.status !== "ok") throw new Error("scan failed");
      assert.equal(
        result.records.filter((item) => !catalogWorkspaceIds.has(item.id))[0]?.generation,
        created.generation,
      );
      assert.equal(
        await restarted.verify("w", created.generation, "."),
        await realpath(linkedPath),
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("runtime activity and explicit confirmation reject removal without stopping sessions", async () => {
  const f = await fixture();
  try {
    const linked = await f.service.create({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: path.join(f.dir, "linked"),
      branch: "feature",
      mode: "new",
      baseRef: "HEAD",
    });
    await assert.rejects(f.service.remove("w", linked.generation, false));
    const busy = await openTargetWorktreeService({
      storageDirectory: path.join(f.dir, "busy-state"),
      executionTargetId: "busy",
      activity: async () => ({ running: 0, waiting: 1, tools: 0, uncertain: 0, offline: false }),
    });
    try {
      await busy.registerBinding({ id: "b", executionTargetId: "busy", repositoryPath: f.main });
      const record = await busy.adopt({
        bindingId: "b",
        workspaceId: "w",
        worktreePath: path.join(f.dir, "linked"),
      });
      await assert.rejects(busy.remove("w", record.generation, true));
      assert.equal(busy.history("w")?.lifecycle, "active");
      assert.equal(
        await busy.verify("w", record.generation, "."),
        await realpath(path.join(f.dir, "linked")),
      );
    } finally {
      await busy.close();
    }
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("bare repository has no runnable main; locked linked tree cannot be removed", async () => {
  const f = await fixture();
  try {
    const bare = path.join(f.dir, "bare.git");
    git(f.main, "clone", "--bare", f.main, bare);
    const bareBinding = await f.service.registerBinding({
      id: "bare",
      executionTargetId: "local-a",
      repositoryPath: bare,
    });
    assert.equal(bareBinding.id, "bare");
    await assert.rejects(
      f.service.adopt({ bindingId: "bare", workspaceId: "bare-w", worktreePath: bare }),
    );
    const linkedPath = path.join(f.dir, "linked");
    const linked = await f.service.create({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: linkedPath,
      branch: "feature",
      mode: "new",
      baseRef: "HEAD",
    });
    git(f.main, "worktree", "lock", linkedPath);
    await assert.rejects(f.service.remove("w", linked.generation, true));
    assert.equal(f.service.history("w")?.lifecycle, "active");
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("explicit stale owner recovery fences old lease and preserves history", async () => {
  const f = await fixture();
  try {
    const record = await f.service.adopt({
      bindingId: "b",
      workspaceId: "main",
      worktreePath: f.main,
    });
    await f.service.close();
    const prefix = createHash("sha256").update("local-a").digest("hex");
    await writeFile(
      path.join(f.storageDirectory, `${prefix}.owner`),
      JSON.stringify({ token: "dead", pid: 2147483647 }),
    );
    await assert.rejects(
      openTargetWorktreeService({
        storageDirectory: f.storageDirectory,
        executionTargetId: "local-a",
        activity: f.activity,
      }),
    );
    const restarted = await openTargetWorktreeService({
      storageDirectory: f.storageDirectory,
      executionTargetId: "local-a",
      activity: f.activity,
      recoverStaleOwner: true,
    });
    try {
      assert.equal(restarted.history("main")?.generation, record.generation);
      assert.equal(await restarted.verify("main", record.generation, "."), await realpath(f.main));
    } finally {
      await restarted.close();
    }
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("main repository relocation requires same-instance evidence and an explicit reanchor", async () => {
  const f = await fixture();
  try {
    const record = await f.service.adopt({
      bindingId: "b",
      workspaceId: "main",
      worktreePath: f.main,
    });
    const moved = path.join(f.dir, "moved-main");
    await rename(f.main, moved);
    assert.equal((await f.service.reconcile("b")).status, "scanFailed");
    assert.equal(f.service.history("main")?.lifecycle, "active");
    assert.equal((await f.service.reconcile("b", moved)).status, "ok");
    assert.equal(await f.service.verify("main", record.generation, "."), await realpath(moved));
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("verified move and branch rename retain identity; competing owner is fenced", async () => {
  const f = await fixture();
  try {
    const old = path.join(f.dir, "linked");
    const next = path.join(f.dir, "renamed");
    const record = await f.service.create({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: old,
      branch: "feature",
      mode: "new",
      baseRef: "HEAD",
    });
    await assert.rejects(
      openTargetWorktreeService({
        storageDirectory: f.storageDirectory,
        executionTargetId: "local-a",
        activity: f.activity,
      }),
    );
    git(f.main, "branch", "-m", "feature", "renamed-feature");
    git(f.main, "worktree", "move", old, next);
    const result = await f.service.reconcile("b");
    assert.equal(result.status, "ok");
    assert.equal(f.service.history("w")?.path, await realpath(next));
    assert.equal(f.service.history("w")?.generation, record.generation);
    assert.equal(await f.service.verify("w", record.generation, "."), await realpath(next));
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
