#!/usr/bin/env node
/** Validate a staged release without reading anything outside its own directory. */
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = [
  "bin/zcode",
  "runtime/node",
  "runtime/server-cli.js",
  "runtime/server-core.js",
  "runtime/piWorker.js",
  "runtime/zcode.cjs",
  "runtime/package.json",
  "runtime/node_modules",
];

export async function verifyLinuxClosure(releaseDir) {
  const root = await realpath(resolve(releaseDir));
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (manifest.product !== "zcode-server" || !/^linux-(x64|arm64)$/.test(manifest.target)) {
    throw new Error("Not a Linux ZCode release");
  }
  if (manifest.nodeVersion !== "24.14.0") throw new Error("Unexpected Node runtime version");
  const paths = [...REQUIRED, ...Object.values(manifest.entrypoints ?? {})];
  if (
    manifest.entrypoints?.cli !== "runtime/server-cli.js" ||
    manifest.entrypoints?.core !== "runtime/server-core.js" ||
    manifest.entrypoints?.agent !== "runtime/zcode.cjs"
  ) {
    throw new Error("Incomplete runtime entrypoints");
  }
  if (
    !Array.isArray(manifest.components) ||
    !manifest.components.some((c) => c.id === "server-runtime") ||
    !manifest.components.some((c) => c.id === "node-runtime") ||
    !manifest.components.some((c) => c.id === "agent-runtime")
  ) {
    throw new Error("Incomplete runtime components");
  }
  const shipped = new Set(manifest.components.flatMap((component) => component.paths));
  // 检查组件重组（而不只是完整 tar）：缺失 launcher/worker 时远端安装会无声失败。
  for (const required of [
    "bin/zcode",
    "runtime/node",
    "runtime/server-cli.js",
    "runtime/server-core.js",
    "runtime/piWorker.js",
    "runtime/zcode.cjs",
    "runtime/node_modules",
  ]) {
    if (!shipped.has(required)) throw new Error(`Runtime component omits ${required}`);
  }
  for (const component of manifest.components) paths.push(...component.paths);
  for (const path of paths) {
    if (
      typeof path !== "string" ||
      !path ||
      isAbsolute(path) ||
      path.split(/[\\/]/).includes("..") ||
      path.includes("\\")
    ) {
      throw new Error(`Unsafe release path: ${path}`);
    }
    const absolute = resolve(root, path);
    const actual = await realpath(absolute);
    if (!inside(root, actual)) throw new Error(`Release path escapes closure: ${path}`);
  }
  await walk(root, root);
  const runtimePackage = JSON.parse(await readFile(join(root, "runtime/package.json"), "utf8"));
  if (runtimePackage.type !== "module") throw new Error("Runtime entrypoints must load as ESM");
  const node = await lstat(join(root, "runtime/node"));
  const launcher = await lstat(join(root, "bin/zcode"));
  if ((node.mode & 0o111) === 0 || (launcher.mode & 0o111) === 0) {
    throw new Error("Node or launcher is not executable");
  }
  return {
    target: manifest.target,
    nodeVersion: manifest.nodeVersion,
    files: await countFiles(root),
  };
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function walk(root, folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = join(folder, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(file);
      if (!inside(root, target))
        throw new Error(`Symlink escapes closure: ${relative(root, file)}`);
      // Realpath also checks dangling links; traversing a directory symlink risks cycles.
    } else if (entry.isDirectory()) {
      await walk(root, file);
    } else if (!entry.isFile()) {
      throw new Error(`Unsupported release entry: ${relative(root, file)}`);
    }
  }
}

async function countFiles(root) {
  let count = 0;
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(dir, entry.name));
      else count++;
    }
  }
  await visit(root);
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: verify-linux-closure.mjs <release-dir>");
  console.log(JSON.stringify(await verifyLinuxClosure(root)));
}
