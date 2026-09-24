import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { stageRelease } from "../packaging/stage.js";
import { ReleaseInstaller } from "../runtime/releaseInstaller.js";
import { currentServerTarget } from "../runtime/manifest.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createReleaseAgentWiring } from "../runtime/agentWiring.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
async function workspacePackages(): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  for (const root of [join(repo, "apps/zcode-cli/packages"), join(repo, "packages")]) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      try {
        const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
          name?: string;
        };
        if (value.name) entries.set(value.name, directory);
      } catch {
        /* directory without package manifest */
      }
    }
  }
  return entries;
}

test(
  "local source Core/CLI/Node executable release is staged, installed, and booted",
  { timeout: 300_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "supervisor-source-release-"));
    const layout = resolveServerLayout(join(dir, "install"));
    const dist = join(repo, "packages/zcode-server-cli/dist");
    const agent = join(repo, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
    const paths = [
      join(dist, "server-cli.js"),
      join(dist, "server-core.js"),
      join(dist, "piWorker.js"),
      agent,
      process.execPath,
    ];
    let core: ChildProcess | undefined;
    let coreClosed: Promise<void> | undefined;
    try {
      for (const path of paths) await access(path); // no empty or synthetic Core fallback
      assert.equal(process.version, "v24.14.0");
      const sourceHashes = await Promise.all(paths.map(hash));
      const target = currentServerTarget();
      const staged = await stageRelease({
        target,
        appVersion: "local-source-a",
        distDir: dist,
        agentBundlePath: agent,
        nodeBinaryPath: process.execPath,
        workspaceNodeModulesDir: join(repo, "node_modules"),
        workspacePackageDirs: await workspacePackages(),
        outputDir: join(dir, "stage"),
        notices: {
          thirdParty: await readFile(join(repo, "NOTICE.md"), "utf8"),
          node: "LOCAL TEST ONLY: pinned Node 24.14.0, not a published release notice",
          nodeSource:
            "LOCAL TEST ONLY: process.execPath from mise; provenance is not official distribution certification",
        },
      });
      assert.ok(staged.archivePath);
      const installer = new ReleaseInstaller(layout);
      const archiveSha256 = await hash(staged.archivePath);
      const manifest = await installer.installArchive({
        archivePath: staged.archivePath,
        target,
        version: "local-source-a",
        archiveSha256,
      });
      const releases = new ReleaseManager(layout);
      assert.deepEqual(await releases.readPending(), manifest);
      assert.equal(manifest.archiveSha256, archiveSha256);
      assert.equal(
        manifest.components?.some((component) => component.id === "server-runtime"),
        true,
      );
      // Actual generated server-core.js has require2("node-pty/lib/utils"); alias must not be omitted.
      assert.equal(
        (
          await stat(join(manifest.releaseDir, "runtime/node_modules/node-pty/package.json"))
        ).isFile(),
        true,
      );
      const consumed = [
        "runtime/server-cli.js",
        "runtime/server-core.js",
        "runtime/piWorker.js",
        "runtime/zcode.cjs",
        "runtime/node",
      ];
      for (let index = 0; index < consumed.length; index++) {
        const file = join(manifest.releaseDir, consumed[index]!);
        assert.equal((await stat(file)).isFile(), true);
        assert.equal(await hash(file), sourceHashes[index]);
      }
      await releases.applyPendingWithTransaction(null);
      assert.deepEqual(await releases.readCurrentForExecution(), manifest);
      await releases.completeUpdate();
      assert.equal(
        await stat(layout.updateTransactionFile).then(
          () => true,
          () => false,
        ),
        false,
      );
      const runtime = join(manifest.releaseDir, "runtime");
      const provider = join(dir, "builtin.json");
      await writeFile(
        provider,
        JSON.stringify({
          schemaVersion: 1,
          revision: 0,
          config: {
            providerConfigRules: { templateRules: [], providerRules: [] },
            modelConfigRules: {
              modelRules: [],
              modelApiRules: [],
              providerSiteRules: [],
              templateModelRules: [],
              builtinProviderModelRules: [],
            },
          },
        }),
      );
      const runtimeNode = join(runtime, "node");
      core = fork(join(runtime, "server-core.js"), ["1", "open"], {
        execPath: runtimeNode,
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: join(dir, "config"),
          ZCODE_DATA_BASE_DIR: dir,
          ZCODE_SERVER_ROOT: layout.serverRoot,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
          ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
          ...createReleaseAgentWiring(runtime, runtimeNode, {}),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      coreClosed = new Promise<void>((resolve) => core!.once("close", () => resolve()));
      let stderr = "";
      core.stderr?.on("data", (part: Buffer) => {
        stderr += part.toString().replaceAll(dir, "<profile>");
      });
      const result = await new Promise<Record<string, unknown>>((resolveResult, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`installed Core ready timeout: ${stderr}`)),
          25_000,
        );
        core!.on("message", (message: Record<string, unknown>) => {
          if (message.type === "ready" || message.type === "fatal") {
            clearTimeout(timer);
            resolveResult(message);
          }
        });
        core!.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`installed Core closed ${code}: ${stderr}`));
        });
      });
      assert.equal(result.type, "ready", JSON.stringify(result));
      assert.equal(result.generation, 1);
      assert.equal(result.bootLeaseId, undefined);
      core.send({ command: "shutdown" });
      await coreClosed;
      assert.equal(core.exitCode, 0);
    } finally {
      if (core && core.exitCode === null) core.kill("SIGTERM");
      if (core && coreClosed) {
        const settled = await Promise.race([
          coreClosed.then(() => true),
          new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 2000)),
        ]);
        if (!settled) {
          core.kill("SIGKILL");
          await coreClosed;
        }
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  },
);
