import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPortablePiBoundary } from "../src/agent-adapters/pi/piPortableFileTools.js";

const run = promisify(execFile);
const supported = process.platform === "darwin" || process.platform === "linux";
test(
  "portable mounted operations pin parent and leaf before approval, refuse substitutions and reap broker",
  { skip: !supported, timeout: 20000 },
  async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pi-portable-"));
    const root = join(tmp, "root");
    const outside = join(tmp, "outside");
    await mkdir(join(root, "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "nested", "file.txt"), "inside");
    await writeFile(join(outside, "file.txt"), "SECRET_OUTSIDE");
    let activeTurn: string | undefined = "turn";
    const boundary = await createPortablePiBoundary(root, root, () => activeTurn);
    const tool = (mode: "read" | "edit" | "write") =>
      boundary.tools.find((item) => item.name === mode)!;
    const execute = async (
      mode: "read" | "edit" | "write",
      id: string,
      input: unknown,
      signal?: AbortSignal,
    ) => tool(mode).execute(id, input as never, signal, undefined, { cwd: root } as never);
    try {
      const edit = { path: "nested/file.txt", edits: [{ oldText: "inside", newText: "pinned" }] };
      await boundary.prepare("edit", "turn", "edit", edit);
      const [pid] = boundary.brokerPids();
      assert.ok(pid);
      await rename(join(root, "nested"), join(root, "old-nested"));
      await symlink(outside, join(root, "nested"));
      // SDK's own path lookup may now refuse the moved path; it must never edit outside.
      await execute("edit", "edit", edit);
      assert.equal(await readFile(join(root, "old-nested", "file.txt"), "utf8"), "pinned");
      assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "SECRET_OUTSIDE");
      assert.equal(boundary.pendingCount(), 0);
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      await rm(join(root, "nested"));
      await rename(join(root, "old-nested"), join(root, "nested"));
      const leafEdit = {
        path: "nested/file.txt",
        edits: [{ oldText: "pinned", newText: "same-inode" }],
      };
      await boundary.prepare("leaf", "turn", "edit", leafEdit);
      await rename(join(root, "nested", "file.txt"), join(root, "nested", "held.txt"));
      await symlink(join(outside, "file.txt"), join(root, "nested", "file.txt"));
      await execute("edit", "leaf", leafEdit);
      assert.equal(await readFile(join(root, "nested", "held.txt"), "utf8"), "same-inode");
      assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "SECRET_OUTSIDE");
      const readInput = { path: "nested/held.txt" };
      await boundary.prepare("read-held", "turn", "read", readInput);
      await rename(join(root, "nested", "held.txt"), join(root, "nested", "read-inode.txt"));
      await symlink(join(outside, "file.txt"), join(root, "nested", "held.txt"));
      const readResult = await execute("read", "read-held", readInput);
      assert.match(JSON.stringify(readResult.content), /same-inode/);
      assert.doesNotMatch(JSON.stringify(readResult.content), /SECRET_OUTSIDE/);

      const create = { path: "nested/new.txt", content: "new" };
      await boundary.prepare("denied", "turn", "write", create);
      await boundary.release("denied");
      await assert.rejects(readFile(join(root, "nested", "new.txt")), { code: "ENOENT" });
      await boundary.prepare("absent", "turn", "write", create);
      await symlink(join(outside, "file.txt"), join(root, "nested", "new.txt"));
      await assert.rejects(execute("write", "absent", create), /EEXIST|refused/);
      assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "SECRET_OUTSIDE");
      await rm(join(root, "nested", "new.txt"));

      await boundary.prepare("stale", "turn", "write", create);
      activeTurn = undefined;
      await assert.rejects(execute("write", "stale", create), /matching prepared/);
      activeTurn = "turn";
      await assert.rejects(readFile(join(root, "nested", "new.txt")), { code: "ENOENT" });
      await boundary.prepare("mismatch", "turn", "write", create);
      await assert.rejects(
        execute("write", "mismatch", { ...create, content: "other" }),
        /matching prepared/,
      );
      assert.equal(boundary.pendingCount(), 0);
      const aborted = new AbortController();
      await boundary.prepare("aborted", "turn", "write", create);
      aborted.abort();
      await assert.rejects(
        execute("write", "aborted", create, aborted.signal),
        /matching prepared/,
      );
      await assert.rejects(readFile(join(root, "nested", "new.txt")), { code: "ENOENT" });
      await boundary.prepare("allowed", "turn", "write", create);
      await execute("write", "allowed", create);
      assert.equal(await readFile(join(root, "nested", "new.txt"), "utf8"), "new");
      await boundary.prepare("exact", "turn", "edit", {
        path: "nested/new.txt",
        edits: [{ oldText: "new", newText: "exact" }],
      });
      await rename(join(root, "nested"), join(root, "detached"));
      await mkdir(join(root, "nested"));
      await symlink(join(outside, "file.txt"), join(root, "nested", "new.txt"));
      await execute("edit", "exact", {
        path: "nested/new.txt",
        edits: [{ oldText: "new", newText: "exact" }],
      });
      assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "SECRET_OUTSIDE");
      assert.equal(await readFile(join(root, "detached", "new.txt"), "utf8"), "exact");

      await run("mkfifo", [join(root, "nested", "pipe")]);
      await assert.rejects(boundary.prepare("pipe", "turn", "read", { path: "nested/pipe" }));
      await assert.rejects(boundary.prepare("outside", "turn", "read", { path: "nested/new.txt" }));
      const rootMovedCreate = { path: "detached/root-moved.txt", content: "held-root" };
      await boundary.prepare("root-moved", "turn", "write", rootMovedCreate);
      await rename(root, join(tmp, "former-root"));
      await symlink(outside, root);
      await execute("write", "root-moved", rootMovedCreate);
      assert.equal(
        await readFile(join(tmp, "former-root", "detached", "root-moved.txt"), "utf8"),
        "held-root",
      );
      assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "SECRET_OUTSIDE");
      await rm(root);
      await mkdir(root);
      await mkdir(join(root, "nested"));
      await assert.rejects(boundary.prepare("replaced-root", "turn", "write", create));
      assert.equal(boundary.pendingCount(), 0);
      // Independent prepared approvals can overlap; cancellation closes every owned child.
      const concurrent = await createPortablePiBoundary(
        join(tmp, "former-root"),
        join(tmp, "former-root"),
      );
      try {
        await Promise.all(
          ["one", "two", "three"].map((id) =>
            concurrent.prepare(id, "turn", "write", { path: `detached/${id}.txt`, content: id }),
          ),
        );
        const pids = concurrent.brokerPids();
        assert.equal(pids.length, 3);
        await concurrent.releaseAll();
        assert.equal(concurrent.pendingCount(), 0);
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        for (const id of ["one", "two", "three"])
          await assert.rejects(readFile(join(tmp, "former-root", "detached", `${id}.txt`)), {
            code: "ENOENT",
          });
      } finally {
        await concurrent.close();
      }
    } finally {
      await boundary.close();
      await rm(tmp, { recursive: true, force: true });
    }
  },
);
