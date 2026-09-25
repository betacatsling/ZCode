import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planTypecheck, runTypecheck } from "./typecheck-projects.mjs";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "typecheck-closure-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  async function config(name, refs = []) {
    await mkdir(join(cwd, name), { recursive: true });
    await writeFile(
      join(cwd, name, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { composite: true },
        references: refs.map((path) => ({ path })),
      }),
    );
  }
  return { cwd: await realpath(cwd), config };
}

test("plans the full unique transitive closure in dependency order", async (t) => {
  const { cwd, config } = await fixture(t);
  await config("leaf");
  await config("middle", ["../leaf"]);
  await config("first", ["../middle"]);
  await config("last", ["../leaf"]);
  assert.deepEqual(
    (await planTypecheck(cwd, ["first", "last"])).map((path) => path.replace(cwd + "/", "")),
    ["leaf/tsconfig.json", "middle/tsconfig.json", "first/tsconfig.json", "last/tsconfig.json"],
  );
  const visited = [];
  const result = await runTypecheck(cwd, ["first", "last"], async (path) => {
    visited.push(path.replace(cwd + "/", ""));
    return { code: 0, signal: null };
  });
  assert.equal(result, 0);
  assert.deepEqual(visited, [
    "leaf/tsconfig.json",
    "middle/tsconfig.json",
    "first/tsconfig.json",
    "last/tsconfig.json",
  ]);
});

test("fails closed for missing references, malformed configs and cycles", async (t) => {
  const { cwd, config } = await fixture(t);
  await config("missing", ["../does-not-exist"]);
  await assert.rejects(planTypecheck(cwd, ["missing"]), /does-not-exist/);
  await writeFile(join(cwd, "missing", "tsconfig.json"), "{broken");
  await assert.rejects(planTypecheck(cwd, ["missing"]), /tsconfig|JSON|property/i);
  await config("one", ["../two"]);
  await config("two", ["../one"]);
  await assert.rejects(planTypecheck(cwd, ["one"]), /cycle/i);
});

test("stops at compiler diagnostic or termination without running later roots", async (t) => {
  const { cwd, config } = await fixture(t);
  await config("a");
  await config("b");
  const invoked = [];
  const code = await runTypecheck(cwd, ["a", "b"], async (path) => {
    invoked.push(path);
    return { code: 2, signal: null };
  });
  assert.equal(code, 2);
  assert.equal(invoked.length, 1);
  assert.equal(
    await runTypecheck(cwd, ["a", "b"], async () => ({ code: null, signal: "SIGTERM" })),
    143,
  );
});

test("actual installed compiler reports a real TS diagnostic and prevents the next project from building", async (t) => {
  const { cwd, config } = await fixture(t);
  await config("bad");
  await config("next");
  await writeFile(join(cwd, "bad", "broken.ts"), 'export const broken: number = "not a number";\n');
  await writeFile(join(cwd, "next", "marker.ts"), "export const next: number = 1;\n");
  assert.notEqual(await runTypecheck(cwd, ["bad", "next"]), 0);
  await assert.rejects(readFile(join(cwd, "next", "marker.js")), /ENOENT/);
});

test("a previously successful build does not hide a changed source diagnostic", async (t) => {
  const { cwd, config } = await fixture(t);
  await config("fresh");
  await writeFile(join(cwd, "fresh", "value.ts"), "export const value: number = 1;\n");
  assert.equal(await runTypecheck(cwd, ["fresh"]), 0);
  const source = join(cwd, "fresh", "value.ts");
  await writeFile(source, 'export const value: number = "stale";\n');
  await utimes(source, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  assert.notEqual(await runTypecheck(cwd, ["fresh"]), 0);
});

test("root command retains every original entry and covers the checked-out reference closure", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const entries = [
    "packages/rpc",
    "packages/provider",
    "packages/provider-node",
    "packages/shared",
    "packages/services",
    "packages/client",
    "packages/server",
    "packages/zcode-server-cli",
    "packages/ui",
    "packages/web",
    "packages/desktop/tsconfig.host.json",
  ];
  assert.equal(scripts.typecheck, `node scripts/typecheck-projects.mjs ${entries.join(" ")}`);
  const cwd = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const plan = await planTypecheck(cwd, entries);
  assert.deepEqual(
    plan.map((location) => relative(cwd, location)),
    entries.map((entry) => (entry.endsWith(".json") ? entry : `${entry}/tsconfig.json`)),
  );
});
