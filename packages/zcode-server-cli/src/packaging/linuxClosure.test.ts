import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageRelease } from "./stage.js";
// The verifier is deliberately plain JS so staged releases can be validated without workspace packages.
// @ts-expect-error standalone JavaScript verifier deliberately has no TS declaration
import { verifyLinuxClosure } from "../../scripts/verify-linux-closure.mjs";

async function build(
  t: { after(fn: () => void | Promise<void>): void },
  missingDependency = false,
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "node_modules", "fake-pi"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "fake-pi", "package.json"),
    JSON.stringify({ name: "fake-pi", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(root, "node_modules", "fake-pi", "index.js"),
    "export const value='isolated-pi';",
  );
  for (const name of ["server-cli", "server-core"])
    await writeFile(join(root, "dist", `${name}.js`), `console.log('${name}');`);
  await writeFile(
    join(root, "dist", "piWorker.js"),
    `import {value} from '${missingDependency ? "missing-pi" : "fake-pi"}'; console.log(value);`,
  );
  await writeFile(join(root, "zcode.cjs"), "console.log('fake native');");
  await cp(process.execPath, join(root, "node"));
  return {
    root,
    stage: () =>
      stageRelease({
        target: "linux-arm64",
        appVersion: "test",
        distDir: join(root, "dist"),
        agentBundlePath: join(root, "zcode.cjs"),
        nodeBinaryPath: join(root, "node"),
        workspaceNodeModulesDir: join(root, "node_modules"),
        outputDir: join(root, "output"),
        archive: false,
        notices: { thirdParty: "fixture", node: "fixture", nodeSource: "fixture" },
      }),
  };
}

function run(binary: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { HOME: cwd, PATH: "/usr/bin:/bin" } });
    let output = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(output.trim()) : reject(new Error(stderr))));
  });
}

test("actual stage includes launcher in component and starts fake Pi from isolated release", async (t) => {
  const { stage } = await build(t);
  const result = await stage();
  const manifest = JSON.parse(await readFile(join(result.releaseDir, "manifest.json"), "utf8"));
  assert.ok(manifest.components.some((c: { paths: string[] }) => c.paths.includes("bin/zcode")));
  assert.ok((await verifyLinuxClosure(result.releaseDir)).files > 0);
  assert.equal(
    await run(join(result.releaseDir, "bin/zcode"), [], result.releaseDir),
    "server-cli",
  );
  assert.equal(
    await run(
      join(result.releaseDir, "runtime/node"),
      [join(result.releaseDir, "runtime/piWorker.js")],
      result.releaseDir,
    ),
    "isolated-pi",
  );
});

test("missing referenced Pi package rejects staging rather than shipping an incomplete release", async (t) => {
  const { stage } = await build(t, true);
  await assert.rejects(stage(), /Missing production dependency/);
});
