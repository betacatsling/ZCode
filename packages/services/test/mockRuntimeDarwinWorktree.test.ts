import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mockWorktreeAuthorized } from "../src/agent-host/mockRuntime.js";

test("linux and windows mock authorization still rejects a realpath alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-mock-wt-"));
  const realDir = join(root, "real");
  const link = join(root, "link");
  await mkdir(realDir);
  await symlink(realDir, link);
  try {
    const canonical = await realpath(link);
    assert.notEqual(canonical, link);
    assert.equal(await mockWorktreeAuthorized("linux", link, link, canonical), false);
    assert.equal(await mockWorktreeAuthorized("win32", link, link, canonical), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("darwin mock authorization accepts the realpath of the same worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-mock-wt-"));
  const realDir = join(root, "real");
  const link = join(root, "link");
  const other = join(root, "other");
  await mkdir(realDir);
  await mkdir(other);
  await symlink(realDir, link);
  try {
    const canonical = await realpath(link);
    assert.equal(await mockWorktreeAuthorized("darwin", link, link, canonical), true);
    assert.equal(await mockWorktreeAuthorized("darwin", link, link, link), false);
    assert.equal(
      await mockWorktreeAuthorized("darwin", link, other, await realpath(other)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
