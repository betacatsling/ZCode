import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { connectToPersistentTarget } from "@zcode/server/remote/persistentTargetClient.js";
import { resolveServerLayout, serverStatusSchema } from "@zcode/server-cli/target";
import {
  ApiKeyAccessConfig,
  EnumOptionSpecConfig,
  LimitOptionSpecConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
} from "@zcode/provider";
import { createSessionTraceId } from "@zcode/shared";
import { createPersistentDesktopTargetManager } from "./persistentDesktopTarget.js";

const execFileAsync = promisify(execFile);
const GIT_BINARY = "/tmp/catalog-fix-tools/git-2.45.4/git";
const PROVIDER_ID = "persistent-test-provider";
const MODEL_ID = "persistent-test-model";

function fakeModelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 16_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: new EnumOptionSpecConfig({
        values: ["off"],
        map: '{"reasoning_effort":"none"}',
      }),
      maxOutputTokens: new LimitOptionSpecConfig({
        max: 128,
        map: '{"max_tokens": maxOutputTokens}',
      }),
    }),
  });
}

async function createFakeProviderServer(): Promise<{
  origin: string;
  requests: Array<{ authorization?: string; prompt?: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ authorization?: string; prompt?: string }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
      requests.push({
        authorization: request.headers.authorization,
        prompt: parsed.messages?.at(-1)?.content,
      });
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Fake target transcript answer" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 4 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function runTargetCli(options: {
  runtimeDir: string;
  dataBaseDir: string;
  serverRoot: string;
  command: "status" | "stop";
}) {
  return await execFileAsync(
    join(options.runtimeDir, "node"),
    [
      join(options.runtimeDir, "server-cli.js"),
      options.command,
      "--server-root",
      options.serverRoot,
      "--json",
    ],
    {
      cwd: options.serverRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ZCODE_DATA_BASE_DIR: options.dataBaseDir,
        ZCODE_SERVER_ROOT: options.serverRoot,
        ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
        ZCODE_MULTI_HARNESS_ENABLED: "1",
      },
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    },
  );
}

test(
  "production Supervisor/Core keeps native CLI and AgentHost services after target attachment detach",
  { timeout: 90_000 },
  async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../../..");
    const stagedArchive = join(
      repositoryRoot,
      "packages/zcode-server-cli/dist-release/zcode-server-linux-x64.tar.gz",
    );
    const archiveHash = createHash("sha256")
      .update(await readFile(stagedArchive))
      .digest("hex");
    const root = await mkdtemp(join(tmpdir(), "zcode-persistent-core-"));
    const dataBaseDir = join(root, "profile");
    const workspacePath = join(root, "workspace");
    const resourcesDirectory = join(root, "resources");
    const targetId = "local:isolated-production-core";
    const target = resolveServerLayout(join(dataBaseDir, ".zcode", "server"));
    const runtimeDir = join(
      dataBaseDir,
      ".zcode",
      "server",
      "releases",
      `linux-x64-${archiveHash.slice(0, 24)}`,
      "runtime",
    );
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(resourcesDirectory, { recursive: true }),
      mkdir(dataBaseDir, { recursive: true }),
    ]);
    await copyFile(stagedArchive, join(resourcesDirectory, "linux-x64.tar.gz"));
    const manager = createPersistentDesktopTargetManager({
      targetId,
      target: "linux-x64",
      resourcesDirectory,
      dataBaseDir,
      skipServiceRegistration: true,
      environment: {
        ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
        ZCODE_MULTI_HARNESS_ENABLED: "1",
      },
    });

    let endpoint: Awaited<ReturnType<typeof manager.ensure>> | undefined;
    try {
      endpoint = await manager.ensure();
      assert.equal(endpoint.targetId, targetId);
      assert.equal(endpoint.sourceHash, archiveHash);
      assert.ok(endpoint.runtimeArchives["linux-x64"]);
      const connection = await connectToPersistentTarget({
        host: endpoint.host,
        port: endpoint.port,
        expectedTargetId: targetId,
        hostBootstrapToken: endpoint.hostBootstrapToken,
      });
      try {
        const availability = await connection.services.agentHostService.getAvailability();
        assert.equal(availability.target.id, targetId);
        assert.equal(availability.admissionEnabled, true);
        assert.ok(availability.harnesses.includes("pi"));
        const activity = await connection.services.agentHostService.listActivityIndex();
        assert.equal(activity.targetId, targetId);
        assert.equal(activity.complete, true);

        // listSessions starts the real packaged native app-server child in this isolated workspace.
        assert.deepEqual(
          await connection.services.zcodeAgentService.listSessions({ workspacePath }),
          [],
        );
      } finally {
        await connection.disposeAndWait();
      }

      const detachedStatus = serverStatusSchema.parse(
        JSON.parse(
          (
            await runTargetCli({
              runtimeDir,
              dataBaseDir,
              serverRoot: target.serverRoot,
              command: "status",
            })
          ).stdout.trim(),
        ),
      );
      assert.equal(detachedStatus.state, "ready");
      assert.equal(detachedStatus.generation, endpoint.generation);
    } finally {
      // This process and data root are created by the fixture; explicitly stop the isolated Supervisor before cleanup.
      await runTargetCli({
        runtimeDir,
        dataBaseDir,
        serverRoot: target.serverRoot,
        command: "stop",
      }).catch(() => undefined);
      const stopped = serverStatusSchema.parse(
        JSON.parse(
          (
            await runTargetCli({
              runtimeDir,
              dataBaseDir,
              serverRoot: target.serverRoot,
              command: "status",
            })
          ).stdout.trim(),
        ),
      );
      assert.equal(stopped.state, "stopped");
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "production Core reads full native history for a missing cwd but refuses execution fallback",
  { timeout: 120_000 },
  async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../../..");
    const stagedArchive = join(
      repositoryRoot,
      "packages/zcode-server-cli/dist-release/zcode-server-linux-x64.tar.gz",
    );
    const archiveHash = createHash("sha256")
      .update(await readFile(stagedArchive))
      .digest("hex");
    const root = await mkdtemp(join(tmpdir(), "zcode-missing-cwd-history-"));
    const dataBaseDir = join(root, "profile");
    const workspacePath = join(root, "workspace with exact bytes ");
    const resourcesDirectory = join(root, "resources");
    const targetId = "local:isolated-history-fixture";
    const target = resolveServerLayout(join(dataBaseDir, ".zcode", "server"));
    const runtimeDir = join(
      target.serverRoot,
      "releases",
      `linux-x64-${archiveHash.slice(0, 24)}`,
      "runtime",
    );
    const fakeProviderServer = await createFakeProviderServer();
    let supervisorStarted = false;
    await mkdir(workspacePath, { recursive: true });
    await mkdir(resourcesDirectory, { recursive: true });
    await mkdir(dataBaseDir, { recursive: true });
    try {
      await execFileAsync(GIT_BINARY, ["init", "-q", workspacePath]);
      await execFileAsync(GIT_BINARY, ["config", "user.email", "history-test@example.invalid"], {
        cwd: workspacePath,
      });
      await execFileAsync(GIT_BINARY, ["config", "user.name", "Native History Fixture"], {
        cwd: workspacePath,
      });
      await writeFile(join(workspacePath, "README.md"), "isolated native history workspace\n");
      await execFileAsync(GIT_BINARY, ["add", "README.md"], { cwd: workspacePath });
      await execFileAsync(GIT_BINARY, ["commit", "-qm", "isolated native history fixture"], {
        cwd: workspacePath,
      });
      await copyFile(stagedArchive, join(resourcesDirectory, "linux-x64.tar.gz"));

      const providerConfig = new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey: "fixture-only-history-key" }),
        api: new ProviderApiConfig({
          type: "openai-chat-completions",
          baseUrl: `${fakeProviderServer.origin}/v1`,
        }),
      });
      const modelConfig = fakeModelConfig();
      const profileDir = join(dataBaseDir, ".zcode", "v2");
      await mkdir(profileDir, { recursive: true });
      await writeFile(
        join(profileDir, "provider_config.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          config: {
            providerOrder: [PROVIDER_ID],
            providerConfigRules: {
              providerRules: [
                {
                  providerId: PROVIDER_ID,
                  providerName: "Fake history provider",
                  enabled: true,
                  config: providerConfig.toJSON(),
                },
              ],
            },
            modelConfigRules: {
              providerModelRules: [
                { providerId: PROVIDER_ID, modelId: MODEL_ID, config: modelConfig.toJSON() },
              ],
              manualProviderModelRules: [],
            },
            defaultModelSelection: {
              providerId: PROVIDER_ID,
              modelId: MODEL_ID,
              options: { reasoningLevel: "off" },
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      const manager = createPersistentDesktopTargetManager({
        targetId,
        target: "linux-x64",
        resourcesDirectory,
        dataBaseDir,
        skipServiceRegistration: true,
        environment: {
          ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
          ZCODE_MULTI_HARNESS_ENABLED: "1",
          ZCODE_GIT_BINARY: GIT_BINARY,
        },
      });
      const endpoint = await manager.ensure();
      supervisorStarted = true;
      assert.equal(endpoint.sourceHash, archiveHash);
      let worktreeGeneration: string | undefined;
      let workspaceId = "";
      let workspaceIdentity = "";
      let taskId = "";
      const selection = {
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        options: { reasoningLevel: "off" },
      };
      const firstConnection = await connectToPersistentTarget({
        host: endpoint.host,
        port: endpoint.port,
        expectedTargetId: targetId,
        hostBootstrapToken: endpoint.hostBootstrapToken,
      });
      try {
        const worktrees = firstConnection.services.worktreeService;
        assert.ok(worktrees);
        const discovery = await worktrees.discover(workspacePath);
        assert.equal(discovery.kind, "git");
        if (discovery.kind !== "git") throw new Error("fixture Git workspace was not discovered");
        const candidate = discovery.candidates.find((item) => item.worktreePath === workspacePath);
        assert.ok(candidate);
        const adopted = await worktrees.adopt("native-history-project", candidate);
        const workspace = adopted.workspace;
        workspaceId = workspace.id;
        workspaceIdentity = workspace.workspaceIdentity?.trim() || workspace.worktreePath;
        worktreeGeneration = workspace.worktreeGeneration;

        const task = await firstConnection.services.zcodeTaskService.createTask({
          workspacePath,
          workspaceIdentity,
          modelSelection: selection,
          v4Create: true,
        });
        taskId = task.taskId;
        let disposeTerminalListener = (): void => undefined;
        const terminalOutcome = new Promise<{ inputId?: string; outcome: string }>(
          (resolveOutcome) => {
            disposeTerminalListener =
              firstConnection.services.zcodeTaskService.onDynamicTaskTerminalOutcome(taskId)(
                (outcome) => resolveOutcome(outcome),
              );
          },
        );
        const traceId = createSessionTraceId();
        await firstConnection.services.zcodeTaskService.sendPrompt({
          taskId,
          traceId,
          content: "Save the fake target answer in native history.",
          clientMode: "desktop-continuous",
          modelSelection: selection,
        });
        try {
          const result = await terminalOutcome;
          assert.equal(result.outcome, "succeeded");
          assert.equal(result.inputId, traceId);
        } finally {
          disposeTerminalListener();
        }
        assert.equal(fakeProviderServer.requests.length, 1);
        assert.equal(
          fakeProviderServer.requests[0]?.authorization,
          "Bearer fixture-only-history-key",
        );
        const transcript = await firstConnection.services.zcodeAgentService.readSessionMessages({
          workspacePath,
          workspaceIdentity,
          sessionId: taskId,
        });
        assert.match(JSON.stringify(transcript), /Fake target transcript answer/u);
        await firstConnection.services.zcodeAgentService.disposeWorkspace({
          workspacePath,
          workspaceIdentity,
        });
      } finally {
        await firstConnection.disposeAndWait();
      }

      const statusAfterDetach = serverStatusSchema.parse(
        JSON.parse(
          (
            await runTargetCli({
              runtimeDir,
              dataBaseDir,
              serverRoot: target.serverRoot,
              command: "status",
            })
          ).stdout.trim(),
        ),
      );
      assert.equal(statusAfterDetach.state, "ready");
      await rm(workspacePath, { recursive: true, force: true });

      const reattached = await connectToPersistentTarget({
        host: endpoint.host,
        port: endpoint.port,
        expectedTargetId: targetId,
        hostBootstrapToken: endpoint.hostBootstrapToken,
      });
      try {
        const history = await reattached.services.zcodeAgentService.listSessions({
          workspacePath,
          workspaceIdentity,
        });
        assert.ok(history.some((session) => session.sessionId === taskId));
        const transcript = await reattached.services.zcodeAgentService.readSessionMessages({
          workspacePath,
          workspaceIdentity,
          sessionId: taskId,
        });
        assert.match(JSON.stringify(transcript), /Fake target transcript answer/u);
        await assert.rejects(
          reattached.services.zcodeAgentService.createSession({
            workspacePath,
            workspaceIdentity,
            sessionId: "must-not-run-in-fallback",
            model: selection,
          }),
          /workspace-unavailable|workspace-admission-/u,
        );
        assert.equal(fakeProviderServer.requests.length, 1);
        const workspaceCatalog = await reattached.services.worktreeService?.read();
        assert.equal(
          workspaceCatalog?.workspaces.find((workspace) => workspace.id === workspaceId)
            ?.worktreeGeneration,
          worktreeGeneration,
        );
      } finally {
        await reattached.disposeAndWait();
      }
    } finally {
      if (supervisorStarted) {
        await runTargetCli({
          runtimeDir,
          dataBaseDir,
          serverRoot: target.serverRoot,
          command: "stop",
        }).catch(() => undefined);
        const stopped = serverStatusSchema.parse(
          JSON.parse(
            (
              await runTargetCli({
                runtimeDir,
                dataBaseDir,
                serverRoot: target.serverRoot,
                command: "status",
              })
            ).stdout.trim(),
          ),
        );
        assert.equal(stopped.state, "stopped");
      }
      await fakeProviderServer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
