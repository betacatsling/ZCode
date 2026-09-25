import { _electron as electron, expect, test } from "@playwright/test";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "../..");

async function stopOwnedCore(child: ReturnType<typeof fork>): Promise<void> {
  const closed = once(child, "close");
  child.send?.({ command: "shutdown" });
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Core did not close")), 8_000)),
    ]);
  } catch (error) {
    // Only reap this test's own isolated Core, never a shared/user process.
    child.kill("SIGKILL");
    await closed;
    throw error;
  }
}

// Default Core → production Electron window/utility Host/preload/MessagePort → real Shell.
// The first RED run launched the renderer without a Host mount and failed on onboarding.
test("mounted Core → utility Host → public client → actual load Shell one-session browser input", async () => {
  // Finite 100k-event durable append needs a separate bounded window, not an 8h load run.
  test.setTimeout(process.env.ZCODE_MOUNTED_HISTORY_E2E === "1" ? 60 * 60_000 : 90_000);
  const isolated = await mkdtemp(join(tmpdir(), "zcode-actual-shell-"));
  const repo = join(isolated, "repo");
  const installation = join(isolated, "installation");
  const config = join(isolated, "builtin.json");
  const runGit = promisify(execFile);
  let core: ReturnType<typeof fork> | undefined;
  let modelRequests = 0;
  // This listener provides an eligible local Model binding; synthetic Host execution must
  // never reach it. A request is a failed test, not a successful fake-model response.
  const model = createServer((_req, res) => {
    modelRequests++;
    res.writeHead(503);
    res.end("Synthetic load turn must not request a Model");
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(repo);
    await runGit("git", ["init", "-q", repo]);
    await runGit("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    ]);
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Fake Model listener unavailable");
    await writeFile(
      config,
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        config: {
          providerConfigRules: {
            templateRules: [],
            providerRules: [
              {
                providerId: "builtin:fixture",
                providerName: "Local HTTP fixture",
                enabled: true,
                config: {
                  group: "zai-family",
                  builtinModelIds: ["fixture-model"],
                  access: { type: "api-key", apiKey: "fixture-only-not-a-credential" },
                  api: {
                    type: "openai-chat-completions",
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                  },
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [
              {
                modelMatch: ".*",
                config: {
                  enabled: true,
                  properties: {
                    contextWindow: 8192,
                    inputFormat: {
                      supportsText: true,
                      supportsImage: false,
                      supportsVideo: false,
                      supportsAudio: false,
                      supportsPdf: false,
                    },
                    outputFormat: { supportsText: true },
                    supportsToolCall: true,
                    supportsJsonSchemaOutput: false,
                    supportsNativeWebSearch: false,
                    supportsMidConversationSystem: true,
                    requiresMfjsToolSchema: false,
                  },
                  optionSpecs: {
                    maxOutputTokens: { max: 1000, map: '{"max_tokens": maxOutputTokens}' },
                    reasoningLevel: { values: ["off"], map: "{}" },
                  },
                },
              },
            ],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [
              {
                providerId: "builtin:fixture",
                modelId: "fixture-model",
                config: { enabled: true },
              },
            ],
          },
        },
      }),
    );
    const mountedHistory = process.env.ZCODE_MOUNTED_HISTORY_E2E === "1";
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS ?? "",
        `--import=${resolve(desktop, "e2e/actualShellMount.networkGuard.mjs")}`,
      ]
        .filter(Boolean)
        .join(" "),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      HOME: isolated,
      ZCODE_ENV: "test",
      ZCODE_MULTI_HARNESS_ENABLED: "1",
      ZCODE_TELEMETRY_ENABLED: "0",
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
      ZCODE_LOAD_PRODUCT_MOUNT: "1",
      ...(mountedHistory ? { ZCODE_MOUNTED_HISTORY_FIXTURE: "1" } : {}),
      ...(process.env.ZCODE_HISTORY_DIAGNOSTIC_EVENTS
        ? { ZCODE_HISTORY_DIAGNOSTIC_EVENTS: process.env.ZCODE_HISTORY_DIAGNOSTIC_EVENTS }
        : {}),
    };
    core = fork(
      resolve(root, "packages/zcode-server-cli/src/server-core/loadProductMountCore.fixture.ts"),
      [],
      {
        execPath: process.execPath,
        execArgv: ["--import", import.meta.resolve("tsx")],
        env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let coreError = "";
    core.stderr?.on("data", (data: Buffer) => {
      coreError += data.toString();
    });
    const ready = await Promise.race([
      new Promise<{ host: string; port: number; version: string; generation: number }>(
        (accept, reject) => {
          core!.on("message", (message: unknown) => {
            if (
              message &&
              typeof message === "object" &&
              "type" in message &&
              message.type === "ready" &&
              "host" in message &&
              typeof message.host === "string" &&
              "port" in message &&
              typeof message.port === "number" &&
              "version" in message &&
              typeof message.version === "string" &&
              "generation" in message &&
              typeof message.generation === "number"
            )
              accept({
                host: message.host,
                port: message.port,
                version: message.version,
                generation: message.generation,
              });
          });
          core!.once("exit", (code) => reject(new Error(`Core exited ${code}: ${coreError}`)));
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Core boot timeout: ${coreError}`)), 20_000),
      ),
    ]);
    const marker = JSON.parse(await readFile(join(installation, "install.json"), "utf8")) as {
      installationId: string;
    };
    app = await electron.launch({
      executablePath:
        process.env.ZCODE_TEST_ELECTRON_EXECUTABLE ??
        resolve(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
      args: [resolve(desktop, "out/main/loadProductMount.js")],
      env: {
        ...env,
        ZCODE_ACTUAL_CORE_LOCATION: JSON.stringify({
          endpoint: `http://${ready.host}:${ready.port}`,
          installationId: marker.installationId,
          version: ready.version,
          generation: ready.generation,
        }),
        ZCODE_ACTUAL_WORKSPACE_PATH: repo,
      },
      timeout: 25_000,
    });
    const window = await app.firstWindow();
    const rendererErrors: string[] = [];
    window.on("pageerror", (cause) => rendererErrors.push(cause.stack ?? String(cause)));
    let electronDiagnostics = "";
    let observeNativePane = false;
    const nativePaneRpcs: string[] = [];
    app.process().stderr?.on("data", (data: Buffer) => {
      electronDiagnostics = (electronDiagnostics + data.toString()).slice(-12_000);
      const message = data.toString();
      if (observeNativePane && /\[rpc:call\] zcode-(?:session|agent|task)\./.test(message))
        nativePaneRpcs.push(message);
      for (const line of message.split("\n")) {
        if (
          /actual-shell:failed|window Host attached|createAgent FAIL|disposing host resources/.test(
            line,
          )
        )
          console.log(`[electron-boundary] ${line.slice(0, 1600)}`);
      }
    });
    try {
      await expect(window.getByRole("heading", { name: /Fixture Git/ })).toBeVisible({
        timeout: 18_000,
      });
    } catch (cause) {
      console.log(
        `[shell-startup-failure] ${JSON.stringify({ url: window.url(), body: await window.locator("body").innerText(), rendererErrors, electronDiagnostics })}`,
      );
      throw cause;
    }
    // Shell's own mounted hierarchy must expose Core-certified choices, not a fixture picker.
    // This assertion is real product RED before the opt-in Core is connected: the mounted
    // hierarchy must resolve a trusted load session from the SAME Core as this window.
    const id = await app.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __loadProductCreate: () => Promise<string>;
        }
      ).__loadProductCreate(),
    );
    expect(id).toBeTruthy();
    await window.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(window.getByTestId(`session-${id}`)).toBeVisible();
    await window.getByTestId(`session-${id}`).click();
    const pane = window.locator(`[data-session-id="${id}"]`);
    await expect(pane).toBeVisible();
    const draft = window.getByTestId("external-draft-workspace-main");
    const draftStart = await window.evaluate(() => performance.now());
    await draft.fill("Load browser accepted turn");
    const inputPaint = await window.evaluate(async () => {
      const field = document.querySelector('[data-testid="external-draft-workspace-main"]');
      if (!(field instanceof HTMLTextAreaElement) || field.value !== "Load browser accepted turn")
        throw new Error("Browser draft has not reached the visible composer");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return performance.now();
    });
    expect(inputPaint).toBeGreaterThan(draftStart);
    const started = new Promise<void>((accept, reject) => {
      const onMessage = (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "load-turn-started" &&
          "id" in message &&
          message.id === id
        ) {
          core!.off("message", onMessage);
          accept();
        }
      };
      core!.on("message", onMessage);
      setTimeout(() => {
        core!.off("message", onMessage);
        reject(new Error("No accepted Core turn"));
      }, 10_000);
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await started;
    core!.send({ command: "release-load", id });
    await expect(pane).toContainText("Core-owned load product output");
    const painted = await window.evaluate(async (sessionId) => {
      const row = document.querySelector(`[data-session-id="${sessionId}"]`);
      if (!row?.textContent?.includes("Core-owned load product output"))
        throw new Error("Core output has not reached the visible pane");
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return { at: performance.now(), visible: Boolean(row.getClientRects().length) };
    }, id);
    expect(painted.visible).toBe(true);
    const hostPid = await app.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __loadProductHostPid: () => number | undefined;
        }
      ).__loadProductHostPid(),
    );
    expect(hostPid).toBeGreaterThan(0);
    expect(hostPid).not.toBe(core!.pid);
    const rendererPid = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId(),
    );
    expect(rendererPid).toBeGreaterThan(0);
    expect(rendererPid).not.toBe(hostPid);
    expect(rendererPid).not.toBe(core!.pid);
    const resourceFacts = await Promise.all(
      [core!.pid!, hostPid!, rendererPid!].map(async (pid) => {
        const { stdout } = await runGit("ps", ["-o", "rss=", "-p", String(pid)]);
        const rssKiB = Number(stdout.trim());
        if (!Number.isInteger(rssKiB) || rssKiB <= 0) throw new Error(`No RSS for pid ${pid}`);
        return { pid, rssKiB };
      }),
    );
    const owner = (await app.evaluate(
      (_, sessionId) =>
        (
          globalThis as typeof globalThis & {
            __loadProductRead: (id: string) => Promise<unknown>;
          }
        ).__loadProductRead(sessionId),
      id,
    )) as {
      spec: { hostSessionId: string };
      snapshot: { seq: number };
      events: Array<{ kind: string }>;
    };
    expect(owner.spec.hostSessionId).toBe(id);
    expect(owner.snapshot.seq).toBeGreaterThanOrEqual(4);
    expect(owner.events.filter((event) => event.kind === "turn.started")).toHaveLength(1);
    const shellUrl = window.url();
    await window.goto("about:blank");
    expect(core!.exitCode).toBeNull();
    await window.goto(shellUrl);
    await expect(window.getByTestId(`session-${id}`)).toBeVisible();
    await window.getByTestId(`session-${id}`).click();
    await expect(window.locator(`[data-session-id="${id}"]`)).toContainText(
      "Core-owned load product output",
    );
    const after = (await app.evaluate(
      (_, sessionId) =>
        (
          globalThis as typeof globalThis & {
            __loadProductRead: (id: string) => Promise<unknown>;
          }
        ).__loadProductRead(sessionId),
      id,
    )) as typeof owner;
    expect(after.snapshot.seq).toBe(owner.snapshot.seq);
    expect(after.events.filter((event) => event.kind === "turn.started")).toHaveLength(1);
    expect(
      await app.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            __loadProductHostPid: () => number | undefined;
          }
        ).__loadProductHostPid(),
      ),
    ).toBe(hostPid);
    expect(modelRequests).toBe(0);
    console.log(
      `[load-product-diagnostic] ${JSON.stringify({ corePid: core!.pid, hostPid, rendererPid, sessionId: id, ownerSequence: after.snapshot.seq, inputPaintMs: inputPaint - draftStart, painted, resourceFacts })}`,
    );
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        if (core && core.exitCode === null && core.signalCode === null) {
          await stopOwnedCore(core);
        }
      } finally {
        model.closeAllConnections();
        try {
          await new Promise<void>((resolve, reject) =>
            model.close((error) => (error ? reject(error) : resolve())),
          );
        } finally {
          await rm(isolated, { recursive: true, force: true });
        }
      }
    }
  }
});
