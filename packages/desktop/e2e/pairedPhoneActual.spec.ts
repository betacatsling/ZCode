import { _electron as electron, chromium, expect, test } from "@playwright/test";
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
test("actual desktop consent to separate browser Pi input, reconnect and revoke", async () => {
  // 中文：真实 Core fork + Electron 窗口 + 独立 Chromium + Pi 工作流的启动成本远超默认 90s，
  // 单独抬高上限避免把冷启动误报成产品缺陷。
  test.setTimeout(240_000);
  const isolated = await mkdtemp(join(tmpdir(), "zcode-actual-shell-"));
  const repo = join(isolated, "repo");
  const installation = join(isolated, "installation");
  const config = join(isolated, "builtin.json");
  const runGit = promisify(execFile);
  let core: ReturnType<typeof fork> | undefined;
  const requests: Array<{ url: string; body: string }> = [];
  let releaseSecond!: () => void;
  const secondModelBarrier = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let signalSecondRequest!: () => void;
  const secondRequestReceived = new Promise<void>((resolve) => {
    signalSecondRequest = resolve;
  });
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    requests.push({ url: req.url ?? "", body });
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const message = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const held = requests.length === 1;
    message({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Actual Pi phone final" },
          finish_reason: null,
        },
      ],
    });
    if (held) {
      signalSecondRequest();
      await secondModelBarrier;
    }
    message({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    message({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
    res.end("data: [DONE]\n\n");
  });
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
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
      executablePath: resolve(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      args: [resolve(desktop, "out/main/pairedPhoneActual.js")],
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
    console.log("[phone-e2e] desktop window ready");
    let electronError = "";
    app.process().stderr?.on("data", (data: Buffer) => {
      electronError = (electronError + data.toString()).slice(-8_000);
    });
    const rendererErrors: string[] = [];
    window.on("pageerror", (error) => rendererErrors.push(String(error)));
    try {
      await expect(window.getByRole("heading", { name: /Fixture Git/ })).toBeVisible({
        timeout: 18_000,
      });
    } catch (error) {
      throw new Error(
        `Shell startup: body=${(await window.locator("body").innerText()).slice(0, 900)}, renderer=${rendererErrors.join(" | ")}, electron=${electronError
          .split("\n")
          .filter((line) => /failed|error|host/i.test(line))
          .slice(-8)
          .join(" | ")}; ${String(error)}`,
      );
    }
    await window.getByRole("button", { name: /New agent in Main checkout/ }).click();
    await window.getByRole("dialog").getByRole("button", { name: "Create agent" }).click();
    await expect(window.locator("[data-session-id]")).toHaveCount(1);
    const sessionId = await window.locator("[data-session-id]").getAttribute("data-session-id");
    expect(sessionId).toBeTruthy();
    await expect(window.getByRole("button", { name: "Approve phone" })).toBeVisible();
    await window.getByRole("button", { name: "Approve phone" }).click();
    console.log("[phone-e2e] consent clicked");
    const codeLine = window.getByTestId("paired-phone-code");
    try {
      await expect(codeLine).toBeVisible();
    } catch (error) {
      throw new Error(
        `Desktop consent failed: alerts=${JSON.stringify(await window.getByRole("alert").allTextContents())}, renderer=${JSON.stringify(rendererErrors)}, hostErrors=${electronError
          .split("\n")
          .filter((line) => /phone|attachment|scope|denied|error/i.test(line))
          .slice(-12)
          .join(" | ")}; ${String(error)}`,
      );
    }
    console.log("[phone-e2e] consent code visible");
    const code = await codeLine.innerText();
    const status = await codeLine.locator("xpath=..").innerText();
    const origin = status.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(origin).toBeTruthy();
    // Independent Chromium process/profile, not a resized Electron renderer or copied Host port.
    browser = await chromium.launch({
      headless: true,
      executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    });
    console.log("[phone-e2e] independent Chromium ready");
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", (route) => {
      if (route.request().url().startsWith(origin!)) return route.continue();
      return route.abort();
    });
    const phone = await context.newPage();
    const phoneErrors: string[] = [];
    phone.on("pageerror", (error) => phoneErrors.push(String(error)));
    await phone.goto(origin!, { waitUntil: "domcontentloaded", timeout: 10_000 });
    console.log("[phone-e2e] pairing page loaded");
    await expect(phone.getByText("Enter the one-use code shown on your desktop.")).toBeVisible();
    await phone.getByRole("textbox", { name: "Desktop one-use code" }).fill(code);
    await phone.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(phone.getByText("Connected to your existing desktop session.")).toBeVisible({
      timeout: 15_000,
    });
    console.log("[phone-e2e] browser connected");
    try {
      await expect(phone.locator(`[data-session-id="${sessionId}"]`)).toBeVisible({
        timeout: 12_000,
      });
    } catch (error) {
      throw new Error(
        `Browser pane missing: status=${JSON.stringify(await phone.getByRole("status").allTextContents())}, alerts=${JSON.stringify(await phone.getByRole("alert").allTextContents())}, pageErrors=${JSON.stringify(phoneErrors)}; ${String(error)}`,
      );
    }
    console.log("[phone-e2e] existing pane visible");
    await phone
      .getByTestId("external-draft-paired-phone")
      .fill("Pi from the phone", { timeout: 10_000 });
    console.log("[phone-e2e] draft filled");
    await phone.getByRole("button", { name: "Send", exact: true }).click();
    console.log("[phone-e2e] phone input sent");
    await Promise.race([
      secondRequestReceived,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Model never reached")), 12_000),
      ),
    ]);
    expect(requests).toHaveLength(1);
    console.log("[phone-e2e] Model held");
    // Browser disconnect alone does not cancel producer. Reconnect uses cookie and original Host session.
    await phone.close();
    releaseSecond();
    const reconnect = await context.newPage();
    reconnect.on("pageerror", (error) => phoneErrors.push(String(error)));
    await reconnect.goto(origin!, { waitUntil: "domcontentloaded" });
    await reconnect.getByRole("button", { name: "Reconnect" }).click();
    await expect(reconnect.getByText("Connected to your existing desktop session.")).toBeVisible({
      timeout: 15_000,
    });
    await expect(reconnect.locator(`[data-session-id="${sessionId}"]`)).toContainText(
      "Actual Pi phone final",
      { timeout: 20_000 },
    );
    await expect(reconnect.getByTestId("usage-inputTokens")).toContainText("12");
    await expect(reconnect.getByTestId("usage-outputTokens")).toContainText("4");
    expect(requests).toHaveLength(1);
    await window.getByRole("button", { name: "Revoke phone" }).click();
    await expect(
      reconnect.getByText("Disconnected. Reconnect to resume the same session."),
    ).toBeVisible({ timeout: 10_000 });
    const facts = await app.evaluate(
      async (_electron, id) =>
        (
          globalThis as typeof globalThis & { __actualShellRead?: (id: string) => Promise<unknown> }
        ).__actualShellRead?.(id!),
      sessionId,
    );
    expect(JSON.stringify(facts)).toContain("Actual Pi phone final");
    console.log("[phone-e2e] revoke observed");
    expect(rendererErrors).toEqual([]);
    expect(phoneErrors).toEqual([]);
  } finally {
    console.log("[phone-e2e] teardown entered");
    releaseSecond();
    try {
      await browser?.close();
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (core && core.exitCode === null && core.signalCode === null) await stopOwnedCore(core);
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
  }
});
