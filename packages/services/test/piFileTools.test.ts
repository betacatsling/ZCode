import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiFileTools } from "../src/agent-adapters/pi/piFileTools.js";

const linux = process.platform === "linux";

test(
  "unsupported OS cannot create Pi file tools instead of falling back to ambient SDK IO",
  { skip: linux },
  async () => {
    await assert.rejects(createPiFileTools(tmpdir()), /require Linux descriptor-relative IO/);
  },
);

test(
  "Pi file tools bind to descriptors across approved-path symlink swaps",
  { skip: !linux },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-file-"));
    const root = join(dir, "tree");
    const outside = join(dir, "outside");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "src", "source.txt"), "original");
    await writeFile(join(outside, "source.txt"), "SECRET_OUTSIDE");
    try {
      const tools = await createPiFileTools(root);
      const get = (name: string) => {
        const tool = tools.find((item) => item.name === name);
        assert.ok(tool);
        return tool;
      };
      const context = { cwd: root };
      // Test with real SDK definitions: the symlink is installed after the approved lexical
      // tool input exists, before SDK execution. No second realpath check can secure this.
      await rename(join(root, "src"), join(root, "old-src"));
      await symlink(outside, join(root, "src"));
      for (const [name, input] of [
        ["read", { path: "src/source.txt" }],
        [
          "edit",
          { path: "src/source.txt", edits: [{ oldText: "SECRET_OUTSIDE", newText: "changed" }] },
        ],
        ["write", { path: "src/source.txt", content: "changed" }],
      ] as const) {
        await assert.rejects(
          get(name).execute("call", input, undefined, undefined, context),
          /ELOOP|ENOTDIR|symbolic link/,
          `${name} must not follow a swapped directory`,
        );
      }
      assert.equal(await readFile(join(outside, "source.txt"), "utf8"), "SECRET_OUTSIDE");
      await rm(join(root, "src"));
      await rename(join(root, "old-src"), join(root, "src"));
      const read = await get("read").execute(
        "call",
        { path: "src/source.txt" },
        undefined,
        undefined,
        context,
      );
      assert.match(JSON.stringify(read.content), /original/);
      await get("edit").execute(
        "call",
        { path: "src/source.txt", edits: [{ oldText: "original", newText: "updated" }] },
        undefined,
        undefined,
        context,
      );
      assert.equal(await readFile(join(root, "src", "source.txt"), "utf8"), "updated");
      await get("write").execute(
        "call",
        { path: "src/new.txt", content: "created" },
        undefined,
        undefined,
        context,
      );
      assert.equal(await readFile(join(root, "src", "new.txt"), "utf8"), "created");
      // Deterministic race exactly after the backend opens the file but before the SDK
      // operation. The old inode must receive the edit, never the swapped outside file.
      const raced = await createPiFileTools(root, {
        afterOpen: async (path, mode) => {
          if (mode !== "edit") return;
          await rename(path, join(root, "src", "original-inode.txt"));
          await symlink(join(outside, "source.txt"), path);
        },
      });
      const raceEdit = raced.find((item) => item.name === "edit");
      assert.ok(raceEdit);
      await raceEdit.execute(
        "race",
        { path: "src/source.txt", edits: [{ oldText: "updated", newText: "pinned" }] },
        undefined,
        undefined,
        context,
      );
      assert.equal(await readFile(join(outside, "source.txt"), "utf8"), "SECRET_OUTSIDE");
      assert.equal(await readFile(join(root, "src", "original-inode.txt"), "utf8"), "pinned");
      await assert.rejects(
        get("write").execute(
          "call",
          { path: "missing/new.txt", content: "no" },
          undefined,
          undefined,
          context,
        ),
      );
      await assert.rejects(
        get("read").execute(
          "call",
          { path: "../outside/source.txt" },
          undefined,
          undefined,
          context,
        ),
        /outside worktree/,
      );
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(
        get("write").execute(
          "cancelled",
          { path: "src/never.txt", content: "no" },
          abort.signal,
          undefined,
          context,
        ),
        /Operation aborted/,
      );
      await assert.rejects(readFile(join(root, "src", "never.txt")), { code: "ENOENT" });
      await rename(root, join(dir, "old-root"));
      await mkdir(root);
      await mkdir(join(root, "src"));
      await assert.rejects(
        get("write").execute(
          "stale-root",
          { path: "src/new.txt", content: "no" },
          undefined,
          undefined,
          context,
        ),
        /worktree root changed/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
