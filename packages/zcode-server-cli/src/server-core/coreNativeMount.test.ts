import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const dbOverride of ["absolute", "relative"] as const)
  test(
    `public Core factory allocates and rejoins two original native IDs (${dbOverride} DB override)`,
    { timeout: 45000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "native-core-mount-"));
      const config = join(root, "builtin.json");
      await writeFile(
        config,
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
      const models: string[] = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
        models.push(body.model ?? "missing");
        const event = (type: string, data: object) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          event("message_start", {
            message: {
              id: "msg_mount_fixture",
              type: "message",
              role: "assistant",
              model: body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 4, output_tokens: 0 },
            },
          }) +
            event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: "fixture completed" },
            }) +
            event("content_block_stop", { index: 0 }) +
            event("message_delta", {
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 4 },
            }) +
            event("message_stop", {}),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const children: ReturnType<typeof fork>[] = [];
      const boot = async (restart: boolean) => {
        const child = fork(
          fileURLToPath(new URL("./coreNativeMountChild.fixture.ts", import.meta.url)),
          restart ? ["restart"] : [],
          {
            cwd: root,
            execArgv: ["--import", import.meta.resolve("tsx")],
            env: {
              ...process.env,
              HOME: root,
              XDG_CONFIG_HOME: root,
              ZCODE_DATA_BASE_DIR: root,
              ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config,
              CORE_NATIVE_FIXTURE_URL: `http://127.0.0.1:${address.port}/fixture`,
              ZCODE_SESSION_DB_PATH:
                dbOverride === "absolute" ? join(root, "native.sqlite") : "sessions/native.sqlite",
              ZCODE_MULTI_HARNESS_ENABLED: restart ? "0" : "1",
              ZCODE_CORE_NATIVE_CREATE_TEST_ONLY: restart ? "0" : "1",
              ZCODE_AGENT_SERVER_REQUIRES_STORAGE_STARTUP: "1",
              ZCODE_TELEMETRY_ENABLED: "false",
              ZCODE_CORE_NATIVE_DROP_ACK_TEST_ONLY: restart ? "" : "native-create-1",
              ZCODE_CORE_NATIVE_MAPPING_FSYNC_FAULT_TEST_ONLY: restart
                ? ""
                : "native-create-fsync-fault",
              ZCODE_AGENT_SERVER_COMMAND: process.execPath,
              ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
                "--import",
                import.meta.resolve("tsx"),
                fileURLToPath(
                  new URL("../../../../apps/zcode-cli/packages/cli/src/main.ts", import.meta.url),
                ),
                "app-server",
                "--stdio",
              ]),
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        children.push(child);
        let stderr = "";
        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });
        const message = await new Promise<unknown>((resolve, reject) => {
          child.once("message", resolve);
          child.once("exit", (code) => reject(new Error(`Core exited ${code}: ${stderr}`)));
        });
        if (child.exitCode === null)
          await new Promise<void>((resolve) => child.once("close", () => resolve()));
        assert.ok(
          message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "native-created",
          JSON.stringify(message) + stderr,
        );
        return message as {
          type: string;
          ids: string[];
          worktreeCount: number;
          fsyncFailed: boolean;
        };
      };
      try {
        const first = await boot(false);
        assert.equal(first.worktreeCount, 1);
        assert.equal(first.ids.length, 2);
        assert.equal(first.fsyncFailed, true);
        assert.deepEqual(models, [], "draft creation must not call the model");
        const personal = join(root, ".zcode", "v2", "provider_config.json");
        const settings = JSON.parse(await readFile(personal, "utf8"));
        settings.config.providerConfigRules.providerRules[0].config.personalModelIds.push(
          "fixture-other",
        );
        settings.config.modelConfigRules.providerModelRules.push({
          ...settings.config.modelConfigRules.providerModelRules[0],
          modelId: "fixture-other",
        });
        settings.config.defaultModelSelection.modelId = "fixture-other";
        await writeFile(personal, JSON.stringify(settings));
        const restarted = await boot(true);
        assert.deepEqual(restarted.ids, first.ids);
        assert.equal(restarted.worktreeCount, 1);
        assert.ok(
          models.length > 0,
          "existing native transport must make a real fake-HTTP model call",
        );
        assert.ok(
          models.every((model) => model === "fixture-model"),
          `selection drifted after defaults changed: ${models}`,
        );
      } finally {
        for (const child of children)
          if (child.exitCode === null) {
            const close = new Promise<void>((resolve) => child.once("close", () => resolve()));
            child.kill("SIGKILL");
            await close;
          }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
