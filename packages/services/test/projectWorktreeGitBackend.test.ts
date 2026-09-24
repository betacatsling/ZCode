import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createGitWorktree,
  discoverGitWorktrees,
  preflightRemoveGitWorktree,
  removeGitWorktree,
  resolveGitWorktreeCwd,
} from "../src/project-workspaces/adapters/gitWorktreeBackend.js";

const run = promisify(execFile);

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "zcode-git-backend-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "primary");
  const git = async (...args: string[]) =>
    run("git", args, { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } });
  await git("init", "-b", "trunk", repo);
  await writeFile(path.join(repo, "README"), "initial\n");
  await git("-C", repo, "add", "README");
  await git(
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  return { dir, repo, git };
}

test("discovers main and two linked worktrees, NUL paths, descendant cwd and distinct nested repositories", async (t) => {
  const { dir, repo, git } = await fixture(t);
  const odd = path.join(dir, "space\n雪 worktree");
  const second = path.join(dir, "second");
  await createGitWorktree({
    repositoryPath: repo,
    path: odd,
    branch: "feature-one",
    mode: "new",
    baseRef: "HEAD",
  });
  await createGitWorktree({
    repositoryPath: repo,
    path: second,
    branch: "feature-two",
    mode: "new",
    baseRef: "HEAD",
  });
  const inside = path.join(odd, "subfolder");
  await mkdir(inside);
  const found = await discoverGitWorktrees(inside);
  assert.equal(found.worktreeRoot, odd);
  assert.equal(found.worktrees.length, 3);
  assert.equal(found.worktrees.find((entry) => entry.path === repo)?.kind, "main");
  assert.equal(
    found.worktrees.find((entry) => entry.path === odd)?.branch,
    "refs/heads/feature-one",
  );
  assert.equal(found.worktrees.find((entry) => entry.path === second)?.kind, "linked");
  await git("-C", second, "checkout", "--detach", "HEAD");
  assert.equal(
    (await discoverGitWorktrees(inside)).worktrees.find((entry) => entry.path === second)?.detached,
    true,
  );
  assert.equal(await resolveGitWorktreeCwd(odd, inside), inside);
  const external = path.join(dir, "external");
  await mkdir(external);
  await symlink(external, path.join(odd, "escape"));
  await assert.rejects(resolveGitWorktreeCwd(odd, path.join(odd, "escape")));
  const nested = path.join(odd, "nested");
  await git("init", "-b", "trunk", nested);
  assert.notEqual((await discoverGitWorktrees(nested)).gitCommonDir, found.gitCommonDir);
  const bare = path.join(dir, "bare.git");
  await git("init", "--bare", bare);
  const bareFacts = await discoverGitWorktrees(bare);
  assert.equal(bareFacts.worktreeRoot, null);
  assert.equal(bareFacts.worktrees[0]?.kind, "bare");
  await assert.rejects(discoverGitWorktrees(external));
});

test("creation rejects branch injection, occupied paths, checked-out branch and preserves failed operations", async (t) => {
  const { dir, repo, git } = await fixture(t);
  const target = path.join(dir, "linked");
  const hookMarker = path.join(dir, "hook-ran");
  const hook = path.join(repo, ".git", "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\ntouch '${hookMarker}'\n`);
  await chmod(hook, 0o755);
  await assert.rejects(
    createGitWorktree({
      repositoryPath: repo,
      path: target,
      branch: "-evil",
      mode: "new",
      baseRef: "HEAD",
    }),
  );
  await assert.rejects(
    createGitWorktree({ repositoryPath: repo, path: target, branch: "trunk", mode: "existing" }),
  );
  await createGitWorktree({
    repositoryPath: repo,
    path: target,
    branch: "feature",
    mode: "new",
    baseRef: "HEAD",
  });
  await assert.rejects(readFile(hookMarker));
  await assert.rejects(
    createGitWorktree({
      repositoryPath: repo,
      path: path.join(dir, "other"),
      branch: "feature",
      mode: "existing",
    }),
  );
  await assert.rejects(
    createGitWorktree({
      repositoryPath: repo,
      path: path.join(dir, "missing-ref"),
      branch: "new-feature",
      mode: "new",
      baseRef: "--bad-ref",
    }),
  );
  await mkdir(path.join(dir, "occupied"));
  await assert.rejects(
    createGitWorktree({
      repositoryPath: repo,
      path: path.join(dir, "occupied"),
      branch: "another",
      mode: "new",
      baseRef: "HEAD",
    }),
  );
  assert.equal((await discoverGitWorktrees(repo)).worktrees.length, 2);
  assert.equal((await git("-C", repo, "branch", "--list", "new-feature")).stdout.trim(), "");
});

test("discovery reports externally missing worktrees as prunable without pruning", async (t) => {
  const { dir, repo } = await fixture(t);
  const missing = path.join(dir, "missing");
  await createGitWorktree({
    repositoryPath: repo,
    path: missing,
    branch: "old",
    mode: "new",
    baseRef: "HEAD",
  });
  await rm(missing, { recursive: true });
  const found = await discoverGitWorktrees(repo);
  assert.notEqual(found.worktrees.find((entry) => entry.path === missing)?.prunable, null);
  assert.equal(found.worktrees.length, 2);
});

test("preflight reports dirty/untracked/submodule/locked/main and remove refuses risks, retaining branch", async (t) => {
  const { dir, repo, git } = await fixture(t);
  const linked = path.join(dir, "linked");
  await createGitWorktree({
    repositoryPath: repo,
    path: linked,
    branch: "feature",
    mode: "new",
    baseRef: "HEAD",
  });
  assert.equal((await preflightRemoveGitWorktree(repo, repo)).isMain, true);
  await assert.rejects(removeGitWorktree(repo, repo));
  await writeFile(path.join(linked, "README"), "changed");
  await writeFile(path.join(linked, "untracked"), "hello");
  let facts = await preflightRemoveGitWorktree(repo, linked);
  assert.equal(facts.dirty, true);
  assert.equal(facts.untracked, true);
  await assert.rejects(removeGitWorktree(repo, linked));
  await git("-C", linked, "restore", "README");
  await rm(path.join(linked, "untracked"));
  await writeFile(path.join(linked, ".gitignore"), "ignored\n");
  await git("-C", linked, "add", ".gitignore");
  await git(
    "-C",
    linked,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "ignore",
  );
  await writeFile(path.join(linked, "ignored"), "keep");
  assert.equal((await preflightRemoveGitWorktree(repo, linked)).untracked, true);
  await assert.rejects(removeGitWorktree(repo, linked));
  await rm(path.join(linked, "ignored"));
  await git("-C", repo, "worktree", "lock", linked, "--reason", "fixture");
  facts = await preflightRemoveGitWorktree(repo, linked);
  assert.equal(facts.locked, true);
  await assert.rejects(removeGitWorktree(repo, linked));
  await git("-C", repo, "worktree", "unlock", linked);
  await writeFile(path.join(repo, ".git", "worktrees", "linked", "index.lock"), "");
  assert.equal((await preflightRemoveGitWorktree(repo, linked)).gitLocks, true);
  await assert.rejects(removeGitWorktree(repo, linked));
  await rm(path.join(repo, ".git", "worktrees", "linked", "index.lock"));
  const sub = path.join(dir, "sub");
  await git("init", "-b", "trunk", sub);
  await writeFile(path.join(sub, "file"), "ok");
  await git("-C", sub, "add", "file");
  await git(
    "-C",
    sub,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  await git("-C", linked, "-c", "protocol.file.allow=always", "submodule", "add", sub, "module");
  assert.equal((await preflightRemoveGitWorktree(repo, linked)).submodules, true);
  await assert.rejects(removeGitWorktree(repo, linked));
  await git("-C", linked, "reset", "--hard", "HEAD");
  // Git itself refuses removal of a clean worktree with a populated untracked submodule.
  await assert.rejects(removeGitWorktree(repo, linked));
  const clean = path.join(dir, "clean");
  await createGitWorktree({
    repositoryPath: repo,
    path: clean,
    branch: "clean-feature",
    mode: "new",
    baseRef: "HEAD",
  });
  await removeGitWorktree(repo, clean);
  assert.equal(
    (await git("-C", repo, "branch", "--list", "clean-feature")).stdout.trim(),
    "clean-feature",
  );
  assert.equal(await readFile(path.join(repo, "README"), "utf8"), "initial\n");
});
