// Reproducible, non-networked baseline build preparation. Does not alter tracked product source.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const slot = "/Users/ykzheng/Desktop/Projects/Zcode/.tmp/multi-harness-5be7ed74/heavy-slot.py";
const inside = (root, path) => {
  const r = relative(root, path);
  return r !== "" && r !== ".." && !r.startsWith("../") && !isAbsolute(r);
};
async function command(executable, args, cwd, env = process.env) {
  const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const deadline = setTimeout(() => child.kill("SIGTERM"), 240_000);
  let stdout = "",
    stderr = "";
  for (const [stream, append] of [
    [child.stdout, (x) => (stdout += x)],
    [child.stderr, (x) => (stderr += x)],
  ])
    stream.on("data", (chunk) => append(chunk.toString()));
  let exit;
  try {
    exit = await new Promise((ok, fail) => {
      child.on("error", fail);
      child.on("close", ok);
    });
  } finally {
    clearTimeout(deadline);
  }
  return { exit, stdout, stderr };
}
const git = async (cwd, ...args) => {
  const r = await command("git", args, cwd, {
    PATH: process.env.PATH,
    HOME: cwd,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  if (r.exit !== 0) throw new Error("Git identity/preflight failed");
  return r.stdout.trim();
};
async function hash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("build artifact symlink not attributable");
    if (entry.isDirectory()) found.push(...(await files(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found.sort();
}
export async function baselinePreflight(checkout, artifactBase) {
  const source = await realpath(checkout);
  if (
    (await git(source, "rev-parse", "--show-toplevel")) !== source ||
    (await git(source, "status", "--porcelain", "--untracked-files=no"))
  )
    throw new Error("baseline tracked source must remain clean");
  const commit = await git(source, "rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("invalid baseline commit");
  const root = resolve(artifactBase);
  if (root === source || inside(source, root) || inside(root, source))
    throw new Error("external artifact base required");
  const outputs = [
    "packages/desktop/out/main",
    "packages/desktop/out/host",
    "packages/desktop/out/preload",
    "packages/desktop/out/renderer",
  ];
  for (const output of outputs) {
    const ignored = await command("git", ["check-ignore", "-q", output], source);
    if (ignored.exit !== 0) throw new Error("build output must be Git-ignored");
  }
  return { source, commit, root, outputs };
}
export async function prepareBaseline({ checkout, artifactBase, execute = false }) {
  const before = await baselinePreflight(checkout, artifactBase);
  const steps = [
    [
      "mise",
      "exec",
      "--",
      "node",
      "scripts/mise-run.mjs",
      "pnpm",
      "--filter",
      "@zcode/adapters...",
      "--workspace-concurrency=1",
      "-r",
      "build",
    ],
    [
      "mise",
      "exec",
      "--",
      "node",
      "scripts/mise-run.mjs",
      "pnpm",
      "--filter",
      "@zcode/desktop",
      "prepare:build-meta",
    ],
    [
      "mise",
      "exec",
      "--",
      "node",
      "scripts/mise-run.mjs",
      "pnpm",
      "--dir",
      "packages/desktop",
      "exec",
      "tsup",
    ],
    [
      "mise",
      "exec",
      "--",
      "node",
      "scripts/mise-run.mjs",
      "pnpm",
      "--dir",
      "packages/desktop",
      "exec",
      "vite",
      "build",
    ],
  ];
  const manifest = {
    kind: "preserved-baseline-desktop-bundle-preparation",
    sourceCheckout: before.source,
    productionCommit: before.commit,
    toolchain: { node: "24.14.0", pnpm: "10.33.2", source: "mise.toml" },
    commands: steps,
    steps: [],
    artifactFiles: [],
    status: "blocked",
    limitation:
      "Build invocation and source identity do not certify a mounted full Shell, running Host, or renderer latency.",
  };
  if (!execute) return manifest;
  await mkdir(before.root, { recursive: true });
  const saved = join(before.root, "baseline-build-provenance.json");
  const persist = () => writeFile(saved, JSON.stringify(manifest, null, 2) + "\n");
  try {
    // 中文：不安装依赖/不下载包；必须由 MAIN 在隔离资源窗口准备依赖后再执行完整构建。
    if (!(await stat(join(before.source, "node_modules")).catch(() => null))?.isDirectory())
      throw new Error("missing baseline dependencies; no network install attempted");
    for (const args of steps) {
      // 中文：仅传工具路径/语言环境，拒绝继承真实 Provider 密钥、远端端点及用户会话凭证。
      const env = Object.fromEntries(
        ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "MISE_DATA_DIR"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      );
      const r = await command("python3", [slot, ...args], before.source, env);
      manifest.steps.push({
        argv: ["python3", slot, ...args],
        exit: r.exit,
        stdoutSha256: createHash("sha256").update(r.stdout).digest("hex"),
        stderrSha256: createHash("sha256").update(r.stderr).digest("hex"),
      });
      if (r.exit !== 0) throw new Error("baseline build command failed");
    }
    for (const output of before.outputs) {
      const path = join(before.source, output);
      for (const f of await files(path))
        manifest.artifactFiles.push({ path: relative(before.source, f), sha256: await hash(f) });
    }
    if (
      !manifest.artifactFiles.some((f) => f.path.startsWith("packages/desktop/out/main/")) ||
      !manifest.artifactFiles.some((f) => f.path.startsWith("packages/desktop/out/renderer/"))
    )
      throw new Error("missing main or renderer output");
    manifest.status = "built-unmounted";
  } catch (error) {
    manifest.blocker = String(error.message).slice(0, 160);
  } finally {
    const after = await baselinePreflight(before.source, before.root);
    manifest.postBuildCommit = after.commit;
    if (after.commit !== before.commit) {
      manifest.status = "blocked";
      manifest.blocker = "baseline source identity changed";
    }
    await persist();
  }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    value = (key) => args[args.indexOf(key) + 1];
  if (!args.includes("--checkout") || !args.includes("--artifact-base"))
    throw new Error("required --checkout and --artifact-base");
  const result = await prepareBaseline({
    checkout: value("--checkout"),
    artifactBase: value("--artifact-base"),
    execute: args.includes("--execute"),
  });
  console.log(
    JSON.stringify({
      status: result.status,
      commit: result.productionCommit,
      steps: result.steps.length,
      artifactFiles: result.artifactFiles.length,
      blocker: result.blocker ?? null,
    }),
  );
  if (args.includes("--execute") && result.status !== "built-unmounted") process.exitCode = 1;
}
