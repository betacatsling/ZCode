import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

test("process crash after real Git create preserves intent, denies replay and explicitly recovers original generation", async () => {
  const f = await fixture();
  const linkedPath = path.join(f.dir, "linked");
  try {
    await f.service.close();
    const moduleUrl = new URL("../src/project-workspaces/worktreeService.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {openTargetWorktreeService} from ${JSON.stringify(moduleUrl)};
         const service = await openTargetWorktreeService({
           storageDirectory: process.argv[1], executionTargetId: 'local-a',
           activity: async () => ({running:0, waiting:0, tools:0, uncertain:0, offline:false}),
           afterGitCreate: async () => process.exit(77),
         });
         await service.create({bindingId:'b', workspaceId:'w', worktreePath:process.argv[2], branch:'feature', mode:'new', baseRef:'HEAD'});`,
        f.storageDirectory,
        linkedPath,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(child.status, 77, child.stderr);
    assert.equal(git(f.main, "worktree", "list", "--porcelain").includes(linkedPath), true);
    const restarted = await openTargetWorktreeService({
      storageDirectory: f.storageDirectory,
      executionTargetId: "local-a",
      activity: f.activity,
      recoverStaleOwner: true,
    });
    try {
      assert.equal(restarted.pendingCreations()[0]?.workspaceId, "w");
      assert.equal(
        (await restarted.discover("b")).some((candidate) => candidate.path === linkedPath),
        false,
      );
      await assert.rejects(
        restarted.adopt({
          bindingId: "b",
          workspaceId: "other",
          worktreePath: linkedPath,
        }),
        /reserved by pending creation/,
      );
      await assert.rejects(
        restarted.create({
          bindingId: "b",
          workspaceId: "w",
          worktreePath: linkedPath,
          branch: "feature",
          mode: "new",
          baseRef: "HEAD",
        }),
        /result unknown/,
      );
      await assert.rejects(
        restarted.adopt({
          bindingId: "b",
          workspaceId: "w",
          worktreePath: linkedPath,
        }),
        /explicit recovery/,
      );
      const recovered = await restarted.recoverCreation("w");
      assert.equal(recovered.path, await realpath(linkedPath));
      assert.equal(restarted.pendingCreations().length, 0);
      await restarted.close();
      const again = await openTargetWorktreeService({
        storageDirectory: f.storageDirectory,
        executionTargetId: "local-a",
        activity: f.activity,
      });
      try {
        assert.equal(again.history("w")?.generation, recovered.generation);
      } finally {
        await again.close();
      }
    } finally {
      await restarted.close();
    }
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("reviewed orphan cannot adopt a replaced Git administrative instance", async () => {
  const f = await fixture();
  const linkedPath = path.join(f.dir, "linked");
  try {
    await f.service.close();
    const target = await openTargetWorktreeService({
      storageDirectory: f.storageDirectory,
      executionTargetId: "local-a",
      activity: f.activity,
      afterGitCreate: async () => {
        throw new Error("crash after Git effect");
      },
    });
    try {
      await assert.rejects(
        target.create({
          bindingId: "b",
          workspaceId: "w",
          worktreePath: linkedPath,
          branch: "feature",
          mode: "new",
          baseRef: "HEAD",
          receipt: { title: "W", sortOrder: 0, requestKey: "create-w" },
        }),
        /crash after Git effect/,
      );
      assert.equal(target.pendingCreations().length, 1);
      const admin = await realpath(
        git(linkedPath, "rev-parse", "--path-format=absolute", "--absolute-git-dir"),
      );
      const original = await stat(admin);
      const reviewedAdminIdentity = { device: original.dev, inode: original.ino };
      // 中文：两次 Git 检查之间真正移除并重建同路径、同分支的 worktree。
      // 延迟调用 inspectBinding 而不是伪造候选数据，让第二次扫描读取真实新实例。
      const internal = target as unknown as {
        inspectBinding(binding: unknown): Promise<unknown>;
      };
      const inspect = internal.inspectBinding.bind(target);
      let scans = 0;
      internal.inspectBinding = async (binding) => {
        if (++scans === 2) {
          git(f.main, "worktree", "remove", "--force", linkedPath);
          git(f.main, "worktree", "add", "-q", linkedPath, "feature");
        }
        return inspect(binding);
      };
      await assert.rejects(
        target.recoverCreation("w", { reviewedAdminIdentity }),
        /Reviewed Git administrative instance changed/,
      );
      assert.equal(target.history("w"), undefined);
      assert.equal(target.pendingCreations().length, 1);
    } finally {
      await target.close();
    }
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("process crash after Git remove reconciles pending record without deleting the branch", async () => {
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
    await f.service.close();
    const moduleUrl = new URL("../src/project-workspaces/worktreeService.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {openTargetWorktreeService} from ${JSON.stringify(moduleUrl)};
       const service = await openTargetWorktreeService({
         storageDirectory: process.argv[1], executionTargetId: 'local-a',
         activity: async () => ({running:0, waiting:0, tools:0, uncertain:0, offline:false}),
         afterGitRemove: async () => process.exit(78),
       });
       const preview = await service.previewRemoval('w', process.argv[2]);
       if (!preview.safe) process.exit(79);
       await service.remove('w', process.argv[2], true);`,
        f.storageDirectory,
        created.generation,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(child.status, 78, child.stderr);
    const restarted = await openTargetWorktreeService({
      storageDirectory: f.storageDirectory,
      executionTargetId: "local-a",
      activity: f.activity,
      recoverStaleOwner: true,
    });
    try {
      assert.equal(restarted.history("w")?.lifecycle, "pendingRemoval");
      await assert.rejects(restarted.verify("w", created.generation, "."));
      assert.equal((await restarted.reconcile("b")).status, "ok");
      assert.equal(restarted.history("w")?.lifecycle, "removed");
      assert.equal(git(f.main, "show-ref", "--verify", "refs/heads/feature").length > 0, true);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("failed Git create is execution-unknown, cannot be replayed or claimed without Git evidence", async () => {
  const f = await fixture();
  try {
    const linkedPath = path.join(f.dir, "linked");
    await assert.rejects(
      f.service.create({
        bindingId: "b",
        workspaceId: "w",
        worktreePath: linkedPath,
        branch: "not-created",
        mode: "existing",
      }),
    );
    assert.equal(f.service.pendingCreations()[0]?.workspaceId, "w");
    await assert.rejects(f.service.recoverCreation("w"), /missing or ambiguous/);
    await assert.rejects(
      f.service.create({
        bindingId: "b",
        workspaceId: "w",
        worktreePath: linkedPath,
        branch: "not-created",
        mode: "existing",
      }),
      /result unknown/,
    );
    assert.equal(f.service.pendingCreations().length, 1);
  } finally {
    await f.service.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

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
    assert.equal((await f.service.previewRemoval("w", record.generation)).safe, true);
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

test("offline or unknown runtime activity blocks even clean linked removal", async () => {
  const f = await fixture();
  const offline = await openTargetWorktreeService({
    storageDirectory: path.join(f.dir, "offline-state"),
    executionTargetId: "offline",
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: true }),
  });
  try {
    const linked = await f.service.create({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: path.join(f.dir, "linked"),
      branch: "feature",
      mode: "new",
      baseRef: "HEAD",
    });
    await offline.registerBinding({
      id: "b",
      executionTargetId: "offline",
      repositoryPath: f.main,
    });
    const record = await offline.adopt({
      bindingId: "b",
      workspaceId: "w",
      worktreePath: linked.path,
    });
    const preview = await offline.previewRemoval("w", record.generation);
    assert.equal(preview.unknown, true);
    assert.equal(preview.safe, false);
    await assert.rejects(offline.remove("w", record.generation, true), /preview required/);
    assert.equal(offline.history("w")?.lifecycle, "active");
  } finally {
    await offline.close();
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
