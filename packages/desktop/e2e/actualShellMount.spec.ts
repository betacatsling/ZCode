import { _electron as electron, expect, test } from "@playwright/test";
import { fork, execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "../..");

// Default Core → production Electron window/utility Host/preload/MessagePort → real Shell.
// The first RED run launched the renderer without a Host mount and failed on onboarding.
test("actual Core → utility Host → preload → Shell Pi create/input/final/usage", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "zcode-actual-shell-"));
  const repo = join(isolated, "repo");
  const installation = join(isolated, "installation");
  const config = join(isolated, "builtin.json");
  const runGit = promisify(execFile);
  let core: ReturnType<typeof fork> | undefined;
  const requests: Array<{ url: string; body: string }> = [];
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
    message({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [
        { index: 0, delta: { role: "assistant", content: "Actual Pi final" }, finish_reason: null },
      ],
    });
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
      PATH: process.env.PATH,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      TMPDIR: process.env.TMPDIR,
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
      args: [resolve(desktop, "out/main/actualShellMount.js")],
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
    app.process().stderr?.on("data", (data: Buffer) => {
      const message = data.toString();
      if (/actual-shell:failed|window Host attached|createAgent FAIL|disposing host resources/.test(message))
        console.log(`[electron-boundary] ${message.slice(0, 1600)}`);
    });
    await expect(window.getByRole("heading", { name: /Fixture Git/ })).toBeVisible({
      timeout: 12_000,
    });
    // Shell's own mounted hierarchy must expose Core-certified choices, not a fixture picker.
    await window.getByRole("button", { name: /New agent in Main checkout/ }).click();
    await expect(window.getByRole("dialog")).toContainText("Pi");
    await window.getByRole("dialog").getByRole("button", { name: "Create agent" }).click();
    await expect(window.getByRole("dialog")).toHaveCount(0);
    await expect(window.locator("[data-session-id]")).toHaveCount(1);
    await window.getByTestId("external-draft-workspace-main").fill("Say actual Pi final");
    await window.getByRole("button", { name: "Send", exact: true }).click();
    await expect(window.locator("[data-session-id]")).toContainText("Actual Pi final", {
      timeout: 12_000,
    });
    const pane = window.locator("[data-session-id]");
    await expect(pane.getByTestId("usage-inputTokens")).toHaveText("Input: 12", {
      timeout: 12_000,
    });
    await expect(pane.getByTestId("usage-outputTokens")).toHaveText("Output: 4", {
      timeout: 12_000,
    });
    const sessionId = await pane.getAttribute("data-session-id");
    expect(sessionId).toBeTruthy();
    const facts = (await app.evaluate(async (_electron, id) => {
      const read = (
        globalThis as typeof globalThis & {
          __actualShellRead?: (id: string) => Promise<unknown>;
        }
      ).__actualShellRead;
      if (!read || !id) throw new Error("Core read observer unavailable");
      return read(id);
    }, sessionId)) as {
      spec: {
        hostSessionId: string;
        execution: { worktreePath: string; workspaceIdentity: string };
      };
      snapshot: {
        rows: { window: Array<{ kind: string; text?: string }> };
        usage: {
          cumulative: { inputTokens: number; outputTokens: number };
          measured: { inputTokens: boolean; outputTokens: boolean };
        };
      };
      events: Array<{ kind: string }>;
    };
    expect(facts.spec.hostSessionId).toBe(sessionId);
    expect(facts.spec.execution.worktreePath).toBe(await realpath(repo));
    expect(facts.spec.execution.workspaceIdentity).toBeTruthy();
    expect(
      facts.snapshot.rows.window.some(
        (row) => row.kind === "assistantText" && row.text === "Actual Pi final",
      ),
    ).toBe(true);
    expect(facts.snapshot.usage.cumulative.inputTokens).toBe(12);
    expect(facts.snapshot.usage.cumulative.outputTokens).toBe(4);
    expect(facts.snapshot.usage.measured.inputTokens).toBe(true);
    expect(facts.events.some((event) => event.kind === "turn.finished")).toBe(true);
    expect(facts.events.some((event) => event.kind === "usage.accounted")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/chat/completions");
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "fixture-model" });
    expect(requests[0]!.body).toContain("Say actual Pi final");
  } finally {
    await app?.close();
    if (core && core.exitCode === null && core.signalCode === null) {
      const closed = once(core, "close");
      core.send?.({ command: "shutdown" });
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Core did not close")), 8_000),
        ),
      ]);
    }
    model.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      model.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(isolated, { recursive: true, force: true });
  }
});
