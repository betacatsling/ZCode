#!/usr/bin/env node
// 单包构建前补齐 agent 子 workspace（apps/zcode-cli）的 dist 依赖。
//
// 背景：`pnpm --filter <pkg> build` 只执行该包自己的 build 脚本，不经过 turbo，
// 所以 apps/zcode-cli/turbo.json 里的 `dependsOn: ["^build"]` 不会生效；干净检出时
// @zcode/contracts / @zcode/adapters 等包的 dist 尚不存在，adapters/core 的 tsc 报
// TS2307，server/desktop 的 esbuild 解析不到 `@zcode/adapters/model`。
// 而 turbo 的根是 apps/zcode-cli，看不到 packages/server、packages/desktop，
// 无法在 turbo.json 里直接声明它们对 adapters 的依赖。
//
// 做法：沿 workspace:* 依赖边算出 turbo filter 覆盖的包，只要有包的 dist 入口缺失，
// 就用与根 `build:cli-deps` 相同的 turbo 调用补齐（由 turbo 负责 ^build 顺序）。
// 入口都已存在时直接跳过：`pnpm -r build`、`build:bootstrap` 和 turbo 自身已按拓扑序
// 先构建依赖，这里不再重复构建，也不会和并行构建争写同一份 dist。
//
// 用法：node scripts/ensure-cli-deps.mjs <turbo-filter>
//   @zcode/adapters^...  只补 adapters 的依赖（供 adapters 自身 prebuild 使用）
//   @zcode/adapters...   adapters 及其依赖（供 server / desktop prebuild 使用）

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = join(repoRoot, "apps/zcode-cli");
const filter = process.argv[2] ?? "";
const match = /^(@[^/]+\/[^.^]+)(\^?)\.\.\.$/.exec(filter);
if (!match) {
  console.error(
    `[ensure-cli-deps] 需要形如 <pkg>... 或 <pkg>^... 的 turbo filter，收到: ${filter}`,
  );
  process.exit(2);
}
const [, rootName, depsOnly] = match;

// 与 apps/zcode-cli/pnpm-workspace.yaml 一致：turbo 只认识 packages/* 与 tools/*。
const packages = new Map();
for (const group of ["packages", "tools"]) {
  const groupDir = join(cliRoot, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir)) {
    const manifestPath = join(groupDir, entry, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    packages.set(manifest.name, { dir: join(groupDir, entry), manifest });
  }
}
if (!packages.has(rootName)) {
  console.error(`[ensure-cli-deps] ${rootName} 不在 apps/zcode-cli workspace 中`);
  process.exit(2);
}

function workspaceDeps(manifest) {
  const all = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.keys(all).filter(
    (name) => all[name].startsWith("workspace:") && packages.has(name),
  );
}

const selected = new Set();
const queue = depsOnly ? workspaceDeps(packages.get(rootName).manifest) : [rootName];
while (queue.length > 0) {
  const name = queue.pop();
  if (selected.has(name)) continue;
  selected.add(name);
  queue.push(...workspaceDeps(packages.get(name).manifest));
}

// 只检查导出指向构建产物的包；直接导出 src 的包不需要预先构建。
function builtEntryFiles({ manifest }) {
  const rootExport = manifest.exports?.["."];
  if (!rootExport || typeof rootExport !== "object") return [];
  return [rootExport.types, rootExport.import].filter(
    (file) => typeof file === "string" && file.startsWith("./dist/"),
  );
}

const missing = [...selected].filter((name) => {
  const pkg = packages.get(name);
  return builtEntryFiles(pkg).some((file) => !existsSync(join(pkg.dir, file)));
});
if (missing.length === 0) {
  console.log(`[ensure-cli-deps] ${filter}: dist 已就绪，跳过`);
  process.exit(0);
}

console.log(`[ensure-cli-deps] ${filter}: 缺少 dist（${missing.join(", ")}），通过 turbo 构建`);
runCommand(
  "pnpm",
  [
    "exec",
    "turbo",
    "--skip-infer",
    "--cwd",
    "apps/zcode-cli",
    "run",
    "build",
    `--filter=${filter}`,
  ],
  { cwd: repoRoot, env: process.env },
);
