import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

async function configPath(root, requested) {
  const location = path.resolve(root, requested);
  const config = (await stat(location)).isDirectory()
    ? path.join(location, "tsconfig.json")
    : location;
  return realpath(config);
}

/** Read the checked-out project-reference graph; do not replace TypeScript's incremental checking. */
export async function planTypecheck(cwd, roots) {
  if (roots.length === 0) throw new Error("typecheck requires the complete root entry list");
  const visited = new Set();
  const active = new Set();
  const order = [];
  async function visit(requested, from) {
    const location = await configPath(from, requested);
    if (active.has(location)) throw new Error(`TypeScript project-reference cycle at ${location}`);
    if (visited.has(location)) return;
    active.add(location);
    const text = await readFile(location, "utf8");
    const parsed = ts.parseConfigFileTextToJson(location, text);
    if (parsed.error)
      throw new Error(
        `Invalid tsconfig ${location}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`,
      );
    const references = parsed.config?.references ?? [];
    if (!Array.isArray(references)) throw new Error(`Invalid references in ${location}`);
    for (const ref of references) {
      if (typeof ref?.path !== "string" || ref.path.length === 0) {
        throw new Error(`Invalid project reference in ${location}`);
      }
      await visit(ref.path, path.dirname(location));
    }
    active.delete(location);
    visited.add(location);
    order.push(location);
  }
  for (const root of roots) await visit(root, cwd);
  return order;
}

/** Each compiler process releases its resident project programs before the next one starts. */
export async function runTypecheck(cwd, roots, invoke = invokeCompiler) {
  const projects = await planTypecheck(cwd, roots);
  console.log(`[typecheck] ${projects.length} projects in full reference closure`);
  for (const project of projects) {
    console.log(`[typecheck] tsc -b ${path.relative(cwd, project)}`);
    const { code, signal } = await invoke(project, cwd);
    if (signal) return 128 + (constants.signals[signal] ?? 1);
    if (code !== 0) return code ?? 1;
  }
  return 0;
}

async function invokeCompiler(project, cwd) {
  // 进程级隔离是针对单进程 tsc -b 持有全部项目程序直至 OOM；仍让 tsc
  // 自行判断项目引用和增量有效性，不跳过失败项目，也不复制已有产物。
  const compiler = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  const child = spawn(process.execPath, [compiler, "-b", project], {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  let interrupted;
  const forward = (signal) => {
    interrupted ??= signal;
    child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal: interrupted ?? signal }));
    });
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTypecheck(process.cwd(), process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("[typecheck]", error);
      process.exitCode = 1;
    },
  );
}
