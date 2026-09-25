import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";

const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "../..");
const runGit = promisify(execFile);

test("actual Core archive keeps Native and external Shell owners history-only", async () => {
  test.setTimeout(90_000);
  const isolated = await mkdtemp(join(tmpdir(), "zcode-joined-readonly-"));
  const repo = join(isolated, "repo");
  const installation = join(isolated, "installation");
  const builtinConfig = join(isolated, "builtin.json");
  const personalConfig = join(isolated, ".zcode", "v2", "provider_config.json");
  const modelRequests: Array<{ path: string; body: string }> = [];
  let core: ReturnType<typeof fork> | undefined;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const model = createTestModel(modelRequests);

  try {
    await mkdir(repo, { recursive: true });
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
    await new Promise<void>((resolveListen) => model.listen(0, "127.0.0.1", resolveListen));
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("Fixture Model unavailable");
    await writeFile(builtinConfig, createPiBuiltinConfig(address.port));
    await mkdir(join(isolated, ".zcode", "v2"), { recursive: true });
    await writeFile(personalConfig, createNativePersonalConfig(address.port));

    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS ?? "",
        `--import=${resolve(desktop, "e2e/actualShellMount.networkGuard.mjs")}`,
      ]
        .filter(Boolean)
        .join(" "),
      TMPDIR: tmpdir(),
      HOME: isolated,
      ZCODE_ENV: "test",
      ZCODE_MULTI_HARNESS_ENABLED: "1",
      ZCODE_TELEMETRY_ENABLED: "0",
      XDG_CONFIG_HOME: join(isolated, "config"),
      XDG_DATA_HOME: join(isolated, "data"),
      ZCODE_DATA_BASE_DIR: isolated,
      ZCODE_SERVER_ROOT: installation,
      ZCODE_FIXTURE_INSTALL_ROOT: installation,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinConfig,
      ZCODE_DESKTOP_HOME_DIR: isolated,
      ZCODE_DESKTOP_USER_DATA_DIR: join(isolated, "electron-userdata"),
      ZCODE_DESKTOP_SESSION_DATA_DIR: join(isolated, "electron-session"),
      ZCODE_ACTUAL_SHELL_FIXTURE: "1",
      ZCODE_SESSION_DB_PATH: join(isolated, "native.sqlite"),
      ZCODE_CORE_NATIVE_CREATE_TEST_ONLY: "1",
      ZCODE_AGENT_SERVER_REQUIRES_STORAGE_STARTUP: "1",
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
        "--import",
        import.meta.resolve("tsx"),
        resolve(root, "apps/zcode-cli/packages/cli/src/main.ts"),
        "app-server",
        "--stdio",
      ]),
    };
    core = fork(
      resolve(
        root,
        "packages/zcode-server-cli/src/server-core/coreProductionFactoryChild.fixture.ts",
      ),
      [],
      {
        execPath: process.execPath,
        execArgv: ["--import", import.meta.resolve("tsx")],
        env,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let coreDiagnostics = "";
    core.stderr?.on("data", (data: Buffer) => {
      coreDiagnostics = `${coreDiagnostics}${data.toString()}`.slice(-4_000);
    });
    const ready = await waitForCoreReady(core).catch((error: unknown) => {
      throw new Error(`${String(error)}; Core startup stderr: ${coreDiagnostics}`);
    });
    const installationMarker = JSON.parse(
      await readFile(join(installation, "install.json"), "utf8"),
    ) as { installationId: string };
    const location = {
      endpoint: `http://${ready.host}:${ready.port}`,
      installationId: installationMarker.installationId,
      version: ready.version,
      generation: ready.generation,
    };
    app = await electron.launch({
      executablePath:
        process.env.ZCODE_TEST_ELECTRON_EXECUTABLE ??
        resolve(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
      args: [resolve(desktop, "out/main/actualShellMount.js")],
      env: {
        ...env,
        ZCODE_ACTUAL_CORE_LOCATION: JSON.stringify(location),
        ZCODE_ACTUAL_WORKSPACE_PATH: repo,
      },
      timeout: 25_000,
    });
    const window = await app.firstWindow();
    const rendererErrors: string[] = [];
    let electronDiagnostics = "";
    window.on("pageerror", (error) => rendererErrors.push(error.stack ?? String(error)));
    app.process().stderr?.on("data", (data: Buffer) => {
      electronDiagnostics = (electronDiagnostics + data.toString()).slice(-12_000);
    });
    try {
      await expect(window.getByRole("heading", { name: /Fixture Git/ })).toBeVisible({
        timeout: 20_000,
      });
    } catch (error) {
      throw new Error(
        `Shell startup failed: ${JSON.stringify({ url: window.url(), body: await window.locator("body").innerText(), rendererErrors, electronDiagnostics, coreDiagnostics })}`,
        { cause: error },
      );
    }

    await window.getByRole("button", { name: /New agent in Main checkout/ }).click();
    await expect(window.getByRole("dialog")).toContainText("Pi");
    await window.getByRole("dialog").locator('input[name="harness"][value="pi"]').check();
    await window.getByRole("dialog").getByRole("button", { name: "Create agent" }).click();
    await expect(window.getByRole("dialog")).toHaveCount(0);
    try {
      await expect(window.locator("[data-session-id]")).toHaveCount(1, { timeout: 12_000 });
    } catch (error) {
      throw new Error(
        `Core external create did not mount: ${JSON.stringify({ body: await window.locator("body").innerText(), sessionNodes: await window.locator("[data-testid*='session'], [data-session-id]").evaluateAll((nodes) => nodes.map((node) => node.outerHTML.slice(0, 400)).slice(0, 15)), rendererErrors, electronDiagnostics: electronDiagnostics.slice(-1_500), coreDiagnostics })}`,
        { cause: error },
      );
    }
    const externalId = await window.locator("[data-session-id]").getAttribute("data-session-id");
    assert.ok(externalId);
    const externalPane = window.locator(`[data-session-id="${externalId}"]`);
    await externalPane
      .getByTestId("external-draft-workspace-main")
      .fill("External archived history");
    await externalPane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(externalPane).toContainText("External owner history", { timeout: 15_000 });

    const nativeId = await window.evaluate(async () => {
      const bridge = (
        window as typeof window & {
          __actualShellReadonlyJoin?: { createNativeSession(): Promise<string> };
        }
      ).__actualShellReadonlyJoin;
      if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
      return bridge.createNativeSession();
    });
    assert.ok(nativeId);
    await window.evaluate(() => document.defaultView?.dispatchEvent(new Event("focus")), undefined);
    const nativeTreeRow = window.locator('button[data-testid^="session-native:"]');
    await expect(nativeTreeRow).toBeVisible({ timeout: 15_000 });
    await expect(nativeTreeRow).toContainText(nativeId);
    await nativeTreeRow.click();
    const nativePane = window.locator(`[data-session-id="${nativeId}"]`);
    try {
      await expect(nativePane).toBeVisible({ timeout: 8_000 });
    } catch (error) {
      throw new Error(
        `Original Native owner did not mount: ${JSON.stringify({ body: await window.locator("body").innerText(), panes: await window.locator("[data-session-id]").evaluateAll((nodes) => nodes.map((node) => node.outerHTML.slice(0, 300))), alerts: await window.getByRole("alert").allInnerTexts(), rendererErrors, coreDiagnostics })}`,
        { cause: error },
      );
    }
    await nativePane.getByTestId("v4-composer-input").fill("Native archived history");
    await nativePane.getByTestId("v4-composer-send").click();
    await expect(nativePane).toContainText("Native owner history", { timeout: 15_000 });

    await window.getByRole("textbox", { name: "Split session ID" }).fill(externalId);
    await window.getByTestId("split-verified-agent").click();
    await expect(window.getByRole("alert")).toHaveCount(0);
    await expect(window.locator(`[data-session-id="${externalId}"]`)).toHaveCount(1);

    const currentExternal = await window.evaluate(async (id) => {
      const bridge = (
        window as typeof window & {
          __actualShellReadonlyJoin?: { resolveOwner(sessionId: string): Promise<unknown> };
        }
      ).__actualShellReadonlyJoin;
      if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
      return bridge.resolveOwner(id);
    }, externalId);
    assert.equal((currentExternal as { kind?: string; historyOnly?: boolean })?.kind, "external");
    assert.equal(
      (currentExternal as { historyOnly?: boolean }).historyOnly,
      false,
      "live external owner must start writable",
    );
    const nativeBeforeArchive = await window.evaluate(async (id) => {
      const bridge = (
        window as typeof window & {
          __actualShellReadonlyJoin?: { resolveOwner(sessionId: string): Promise<unknown> };
        }
      ).__actualShellReadonlyJoin;
      if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
      return bridge.resolveOwner(id);
    }, nativeId);
    assert.equal((nativeBeforeArchive as { kind?: string })?.kind, "native");
    assert.equal(
      (nativeBeforeArchive as { originalSessionId?: string }).originalSessionId,
      nativeId,
      "the mounted Core must preserve the original CLI session ID",
    );
    assert.equal((nativeBeforeArchive as { historyOnly?: boolean }).historyOnly, false);

    await window.evaluate(async () => {
      const bridge = (
        window as typeof window & {
          __actualShellReadonlyJoin?: { archiveWorkspace(): Promise<void> };
        }
      ).__actualShellReadonlyJoin;
      if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
      await bridge.archiveWorkspace();
    });
    const [archivedNative, archivedExternal] = await Promise.all([
      window.evaluate(async (id) => {
        const bridge = (
          window as typeof window & {
            __actualShellReadonlyJoin?: { resolveOwner(sessionId: string): Promise<unknown> };
          }
        ).__actualShellReadonlyJoin;
        if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
        return bridge.resolveOwner(id);
      }, nativeId),
      window.evaluate(async (id) => {
        const bridge = (
          window as typeof window & {
            __actualShellReadonlyJoin?: { resolveOwner(sessionId: string): Promise<unknown> };
          }
        ).__actualShellReadonlyJoin;
        if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
        return bridge.resolveOwner(id);
      }, externalId),
    ]);
    assert.equal((archivedNative as { kind?: string })?.kind, "native");
    assert.equal((archivedNative as { originalSessionId?: string }).originalSessionId, nativeId);
    assert.equal((archivedNative as { historyOnly?: boolean }).historyOnly, true);
    assert.equal((archivedExternal as { kind?: string })?.kind, "external");
    assert.equal(
      (archivedExternal as { spec?: { hostSessionId?: string } }).spec?.hostSessionId,
      externalId,
    );
    assert.equal((archivedExternal as { historyOnly?: boolean }).historyOnly, true);

    const requestCount = modelRequests.length;
    await assert.rejects(
      window.evaluate(async (id) => {
        const bridge = (
          window as typeof window & {
            __actualShellReadonlyJoin?: { dispatchHostSend(sessionId: string): Promise<unknown> };
          }
        ).__actualShellReadonlyJoin;
        if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
        return bridge.dispatchHostSend(id);
      }, externalId),
      /archived|admission|scope/i,
    );
    await assert.rejects(
      window.evaluate(async () => {
        const bridge = (
          window as typeof window & {
            __actualShellReadonlyJoin?: { createNativeSession(): Promise<string> };
          }
        ).__actualShellReadonlyJoin;
        if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
        return bridge.createNativeSession();
      }),
      /archived|admission|scope/i,
    );
    assert.equal(modelRequests.length, requestCount, "archive refusal must produce no Model IO");

    const hostPid = await app.evaluate(() =>
      (
        globalThis as typeof globalThis & { __actualShellHostPid?: () => number | undefined }
      ).__actualShellHostPid?.(),
    );
    assert.ok(hostPid);
    await window.reload();
    await expect(window.getByRole("heading", { name: /Fixture Git/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(window.locator('button[data-testid^="session-native:"]')).toBeVisible({ timeout: 15_000 });
    await window.locator('button[data-testid^="session-native:"]').click();
    const restoredNative = window.locator(`[data-session-id="${nativeId}"]`);
    const restoredExternal = window.locator(`[data-session-id="${externalId}"]`);
    await expect(restoredNative).toContainText("Native owner history");
    await expect(restoredExternal).toContainText("External owner history");
    await expect(restoredNative.getByTestId("v4-composer")).toHaveCount(0);
    await expect(restoredExternal.getByTestId("external-draft-workspace-main")).toHaveCount(0);
    await expect(restoredExternal.getByRole("button", { name: "Send", exact: true })).toHaveCount(
      0,
    );
    const afterReloadOwners = await Promise.all([
      window.evaluate(async (id) => {
        const bridge = (
          window as typeof window & {
            __actualShellReadonlyJoin?: { resolveOwner(sessionId: string): Promise<unknown> };
          }
        ).__actualShellReadonlyJoin;
        if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
        return bridge.resolveOwner(id);
      }, nativeId),
      window.evaluate(async (id) => {
        const bridge = (
          window as typeof window & {
            __actualShellReadonlyJoin?: { resolveOwner(sessionId: string): Promise<unknown> };
          }
        ).__actualShellReadonlyJoin;
        if (!bridge) throw new Error("Mounted public Core test bridge unavailable");
        return bridge.resolveOwner(id);
      }, externalId),
    ]);
    assert.equal((afterReloadOwners[0] as { historyOnly?: boolean }).historyOnly, true);
    assert.equal((afterReloadOwners[1] as { historyOnly?: boolean }).historyOnly, true);
    assert.equal(
      await app.evaluate(() =>
        (
          globalThis as typeof globalThis & { __actualShellHostPid?: () => number | undefined }
        ).__actualShellHostPid?.(),
      ),
      hostPid,
      "renderer reload must retain the existing window Host",
    );
    assert.equal(modelRequests.length, requestCount, "reload must not replay either prompt");
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        if (core && core.exitCode === null && core.signalCode === null) await stopOwnedCore(core);
      } finally {
        model.closeAllConnections();
        try {
          await new Promise<void>((resolveClose, reject) =>
            model.close((error) => (error ? reject(error) : resolveClose())),
          );
        } finally {
          await rm(isolated, { recursive: true, force: true });
        }
      }
    }
  }
});

function createTestModel(requests: Array<{ path: string; body: string }>) {
  return createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({ path, body });
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    if (path === "/v1/chat/completions") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.end(
        `data: ${JSON.stringify({
          id: "chatcmpl-joined-readonly",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture-model",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "External owner history" },
              finish_reason: null,
            },
          ],
        })}\n\n` +
          `data: ${JSON.stringify({
            id: "chatcmpl-joined-readonly",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n` +
          `data: ${JSON.stringify({
            id: "chatcmpl-joined-readonly",
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture-model",
            choices: [],
            usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
          })}\n\n` +
          "data: [DONE]\n\n",
      );
      return;
    }
    if (path === "/v1/messages") {
      const event = (type: string, data: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        event("message_start", {
          message: {
            id: "msg-joined-readonly",
            type: "message",
            role: "assistant",
            model: "fixture-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        }) +
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
          event("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: "Native owner history" },
          }) +
          event("content_block_stop", { index: 0 }) +
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          }) +
          event("message_stop", {}),
      );
      return;
    }
    response.writeHead(404).end();
  });
}

function createPiBuiltinConfig(port: number): string {
  return JSON.stringify({
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
              api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
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
          { providerId: "builtin:fixture", modelId: "fixture-model", config: { enabled: true } },
        ],
      },
    },
  });
}

function createNativePersonalConfig(port: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "fixture",
            providerName: "Isolated native fixture",
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fixture-only-not-a-credential" },
              api: { type: "anthropic-messages", baseUrl: `http://127.0.0.1:${port}/v1` },
              personalModelIds: ["fixture-model"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: "fixture",
            modelId: "fixture-model",
            config: {
              enabled: true,
              properties: {
                contextWindow: 65536,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: true,
                supportsToolCall: true,
                requiresMfjsToolSchema: false,
                inputFormat: {
                  supportsText: true,
                  supportsImage: false,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: false,
                },
                outputFormat: { supportsText: true },
              },
              optionSpecs: {
                reasoningLevel: { values: ["off"], map: "{}" },
                maxOutputTokens: { max: 2048, map: "{}" },
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: "fixture",
        modelId: "fixture-model",
        options: { reasoningLevel: "off" },
      },
    },
  });
}

async function waitForCoreReady(child: ReturnType<typeof fork>) {
  return await new Promise<{ host: string; port: number; version: string; generation: number }>(
    (resolveReady, reject) => {
      const timeout = setTimeout(() => settle(new Error("Core startup timed out")), 30_000);
      const onMessage = (message: unknown) => {
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
          settle(undefined, {
            host: message.host,
            port: message.port,
            version: message.version,
            generation: message.generation,
          });
      };
      const onClose = () => settle(new Error("Core closed before readiness"));
      const onError = () => settle(new Error("Core process failed before readiness"));
      function settle(
        error?: Error,
        value?: { host: string; port: number; version: string; generation: number },
      ) {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("close", onClose);
        child.off("error", onError);
        if (error) reject(error);
        else if (value) resolveReady(value);
      }
      child.on("message", onMessage);
      child.once("close", onClose);
      child.once("error", onError);
    },
  );
}

async function stopOwnedCore(child: ReturnType<typeof fork>): Promise<void> {
  const closed = once(child, "close");
  child.send?.({ command: "shutdown" });
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Core did not close")), 8_000)),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await closed;
    throw error;
  }
}
