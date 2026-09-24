import { _electron as electron, expect, test } from "@playwright/test";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "../..");

// RED acceptance: real default Core + original Electron preload/renderer, not the controlled
// shell-pane fixture. The initial Electron entry intentionally has no Host mount; the assertion
// must fail until a production window Host attachment and actual Shell creation are wired.
test("actual Core → utility Host → preload → Shell Pi create/input/final/usage", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "zcode-actual-shell-"));
  const repo = join(isolated, "repo");
  const installation = join(isolated, "installation");
  const config = join(isolated, "builtin.json");
  const runGit = promisify(execFile);
  let core: ReturnType<typeof fork> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(repo);
    await runGit("git", ["init", "-q", repo]);
    await runGit("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
    await writeFile(config, JSON.stringify({ schemaVersion: 1, revision: 0, config: {
      providerConfigRules: { templateRules: [], providerRules: [] }, modelConfigRules: {
        modelRules: [], modelApiRules: [], providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [],
      },
    } }));
    const env = {
      ...process.env,
      HOME: isolated,
      XDG_CONFIG_HOME: join(isolated, "config"),
      XDG_DATA_HOME: join(isolated, "data"),
      ZCODE_DATA_BASE_DIR: isolated,
      ZCODE_SERVER_ROOT: installation,
      ZCODE_FIXTURE_INSTALL_ROOT: installation,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config,
      ZCODE_DESKTOP_HOME_DIR: isolated,
      ZCODE_DESKTOP_USER_DATA_DIR: join(isolated, "electron-userdata"),
      ZCODE_DESKTOP_SESSION_DATA_DIR: join(isolated, "electron-session"),
      ZCODE_ACTUAL_SHELL_FIXTURE: "1",
    };
    core = fork(resolve(root, "packages/zcode-server-cli/src/server-core/coreProductionFactoryChild.fixture.ts"), [], {
      execPath: process.execPath, execArgv: ["--import", import.meta.resolve("tsx")],
      env, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let coreError = "";
    core.stderr?.on("data", (data: Buffer) => { coreError += data.toString(); });
    const ready = await Promise.race([
      new Promise<{ host: string; port: number }>((accept, reject) => {
        core!.on("message", (message: unknown) => {
          if (message && typeof message === "object" && "type" in message && message.type === "ready" &&
            "host" in message && typeof message.host === "string" && "port" in message && typeof message.port === "number")
            accept({ host: message.host, port: message.port });
        });
        core!.once("exit", (code) => reject(new Error(`Core exited ${code}: ${coreError}`)));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Core boot timeout: ${coreError}`)), 20_000)),
    ]);
    const marker = JSON.parse(await readFile(join(installation, "install.json"), "utf8")) as { installationId: string };
    app = await electron.launch({
      executablePath: resolve(desktop, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
      args: [resolve(desktop, "e2e/actualShellMount.main.cjs")],
      env: { ...env, ZCODE_ACTUAL_CORE_LOCATION: JSON.stringify({
        endpoint: `http://${ready.host}:${ready.port}`, installationId: marker.installationId,
        version: "3.14.3", generation: 1,
      }), ZCODE_ACTUAL_WORKSPACE_PATH: repo },
      timeout: 25_000,
    });
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: /Fixture Git/ })).toBeVisible({ timeout: 12_000 });
    // Must originate from the actual Shell and yield Host + fake-Model receipts (added after RED).
    await expect(window.getByRole("button", { name: /Pi/ })).toBeEnabled();
  } finally {
    await app?.close();
    if (core && core.exitCode === null && core.signalCode === null) {
      const closed = once(core, "close");
      core.send?.({ command: "shutdown" });
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Core did not close")), 8_000))]);
    }
    await rm(isolated, { recursive: true, force: true });
  }
});
