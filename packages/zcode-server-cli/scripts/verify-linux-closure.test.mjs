import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyLinuxClosure } from "./verify-linux-closure.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zcode-linux-closure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime/node_modules/fake-pi"), { recursive: true });
  await mkdir(join(root, "bin"));
  await cp(process.execPath, join(root, "runtime/node"));
  await writeFile(join(root, "runtime/package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(root, "runtime/node_modules/fake-pi/package.json"),
    JSON.stringify({ name: "fake-pi", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(root, "runtime/node_modules/fake-pi/index.js"),
    "export const answer = 'pi-from-package';\n",
  );
  await writeFile(
    join(root, "runtime/piWorker.js"),
    "import {answer} from 'fake-pi'; console.log(answer);\n",
  );
  await writeFile(join(root, "runtime/server-cli.js"), "console.log('cli-from-package');\n");
  await writeFile(join(root, "runtime/server-core.js"), "console.log('core-from-package');\n");
  await writeFile(join(root, "runtime/zcode.cjs"), "console.log('agent-from-package');\n");
  await writeFile(
    join(root, "bin/zcode"),
    '#!/bin/sh\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$DIR/runtime/node" "$DIR/runtime/server-cli.js" "$@"\n',
  );
  await chmod(join(root, "bin/zcode"), 0o755);
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      product: "zcode-server",
      target: "linux-x64",
      nodeVersion: "24.14.0",
      entrypoints: {
        cli: "runtime/server-cli.js",
        core: "runtime/server-core.js",
        agent: "runtime/zcode.cjs",
      },
      components: [
        { id: "node-runtime", paths: ["runtime/node"] },
        {
          id: "server-runtime",
          paths: [
            "bin/zcode",
            "runtime/server-cli.js",
            "runtime/server-core.js",
            "runtime/node_modules",
            "runtime/piWorker.js",
          ],
        },
        { id: "agent-runtime", paths: ["runtime/zcode.cjs"] },
      ],
    }),
  );
  return root;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: "/usr/bin:/bin", HOME: cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr))));
  });
}

test("isolated release can execute CLI and fake Pi worker without workspace/HOME modules", async (t) => {
  const root = await fixture(t);
  assert.equal((await verifyLinuxClosure(root)).nodeVersion, "24.14.0");
  assert.equal(await run(join(root, "bin/zcode"), [], root), "cli-from-package");
  assert.equal(
    await run(join(root, "runtime/node"), [join(root, "runtime/piWorker.js")], root),
    "pi-from-package",
  );
});

test("closure rejects escaped symlinks, missing Pi, unpinned Node and component path traversal", async (t) => {
  const root = await fixture(t);
  await symlink(tmpdir(), join(root, "runtime/node_modules/escape"));
  await assert.rejects(verifyLinuxClosure(root), /Symlink escapes/);
  await rm(join(root, "runtime/node_modules/escape"));
  await rm(join(root, "runtime/piWorker.js"));
  await assert.rejects(verifyLinuxClosure(root), /ENOENT/);
  await writeFile(join(root, "runtime/piWorker.js"), "");
  const manifestPath = join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.nodeVersion = "22.16.0";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyLinuxClosure(root), /Node runtime version/);
  manifest.nodeVersion = "24.14.0";
  manifest.components[1].paths = manifest.components[1].paths.filter((p) => p !== "bin/zcode");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyLinuxClosure(root), /component omits bin\/zcode/);
  manifest.components[1].paths.push("bin/zcode");
  manifest.components[0].paths = ["../../outside", "runtime/node"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyLinuxClosure(root), /Unsafe release path/);
});
