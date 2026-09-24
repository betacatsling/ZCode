import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";

const childMode = process.env.ZCODE_NATIVE_BOOT_FIXTURE_CHILD === "1";
if (childMode) {
  const { runZCodeProtocolAgent } = await import("./zcode-protocol-entrypoint.js");
  const {
    ApiKeyAccessConfig,
    ModelConfig,
    ModelConfigRules,
    ProviderApiConfig,
    ProviderConfig,
    ProviderConfigMap,
    ProviderRegistryService,
    ProviderTemplateMap,
  } = await import("@zcode/provider");
  const revision = "fixture-v1";
  const registry = new ProviderRegistryService({
    configSource: {
      read: async () => ({
        revision,
        zcodeBuiltinRevision: revision,
        personalRevision: revision,
        zcodeBuiltinProviders: ProviderConfigMap.empty(),
        zcodeBuiltinProviderTemplates: new ProviderTemplateMap(),
        personalProviders: new ProviderConfigMap([
          [
            "fixture",
            new ProviderConfig({
              group: "standard-personal",
              access: new ApiKeyAccessConfig({ apiKey: "fixture-not-secret" }),
              api: new ProviderApiConfig({
                type: "anthropic-messages",
                baseUrl: process.env.ZCODE_BOOT_FIXTURE_URL!,
              }),
              personalModelIds: ["fixture-model"],
            }),
          ],
        ]),
        zcodeBuiltinModelRules: ModelConfigRules.empty(),
        personalModels: ModelConfigRules.empty().setExact(
          "fixture",
          "fixture-model",
          ModelConfig.fromData({
            enabled: true,
            properties: {
              contextWindow: 65536,
              requiresMfjsToolSchema: false,
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
            },
            optionSpecs: {
              reasoningLevel: { values: ["off"], map: "{}" },
              maxOutputTokens: { max: 2048, map: "{}" },
            },
          }),
        ),
      }),
      onDidChange: () => () => {},
    },
    accountSource: {
      read: async () => ({
        revision: "none",
        basedOnZCodeBuiltinRevision: revision,
        providers: ProviderConfigMap.empty(),
      }),
      onDidChange: () => () => {},
    },
  });
  await registry.start();
  const snapshot = registry.getSnapshot()!;
  await runZCodeProtocolAgent(
    {
      cwd: process.env.ZCODE_BOOT_FIXTURE_CWD!,
      env: process.env,
      input: process.stdin,
      output: process.stdout,
    },
    {
      startProviderRegistryRuntime: async () => ({
        runtime: { registryService: registry },
        snapshot,
        configuredDefaultModelSelection: { providerId: "fixture", modelId: "fixture-model" },
        syncAccountProviderConfig: async () => {
          throw new Error("fixture account overlay disabled");
        },
        dispose: () => registry.dispose(),
      }),
    },
  );
} else {
  test(
    "native V4 subprocess uses injected real Registry and Model executor with fake upstream",
    { timeout: 40000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "native-boot-v4-"));
      const cwd = join(root, "worktree");
      await mkdir(cwd);
      const fixturePath = join(cwd, "input.txt");
      await writeFile(fixturePath, "seed=violet\n");
      let requests = 0;
      let sawSecondPrompt = false;
      let sawCurrentRead = false;
      let secondToolIssued = false;
      const upstream = createServer(async (request, response) => {
        requests++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        // Only derive a boolean from disposable fixture text; never retain request, URL or headers.
        const body = Buffer.concat(chunks);
        sawSecondPrompt ||= body.includes(Buffer.from("fixture instruction 2"));
        sawCurrentRead ||= sawSecondPrompt && body.includes(Buffer.from("seed=amber"));
        const tool = requests === 1 || (sawSecondPrompt && !secondToolIssued);
        if (sawSecondPrompt && tool) secondToolIssued = true;
        const event = (type: string, data: object) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        const text = `fixture-turn-${requests}`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          event("message_start", {
            message: {
              id: `msg_fixture_${requests}`,
              type: "message",
              role: "assistant",
              model: "fixture-model",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 4, output_tokens: 0 },
            },
          }) +
            (tool
              ? event("content_block_start", {
                  index: 0,
                  content_block: {
                    type: "tool_use",
                    id: `toolu_fixture_${requests}`,
                    name: "Read",
                    input: {},
                  },
                }) +
                event("content_block_delta", {
                  index: 0,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify({ file_path: fixturePath }),
                  },
                })
              : event("content_block_start", {
                  index: 0,
                  content_block: { type: "text", text: "" },
                }) +
                event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })) +
            event("content_block_stop", { index: 0 }) +
            event("message_delta", {
              delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: 4 },
            }) +
            event("message_stop", {}),
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      const address = upstream.address();
      assert.ok(address && typeof address !== "string");
      const child = spawn(
        process.execPath,
        ["--import", "tsx", new URL(import.meta.url).pathname],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: root,
            ZCODE_DATA_BASE_DIR: root,
            ZCODE_SESSION_DB_PATH: "session.sqlite",
            ZCODE_NATIVE_BOOT_FIXTURE_CHILD: "1",
            ZCODE_BOOT_FIXTURE_CWD: cwd,
            ZCODE_BOOT_FIXTURE_URL: `http://127.0.0.1:${address.port}`,
            ZCODE_TELEMETRY_ENABLED: "false",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8) stderr.push(chunk);
      });
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const next = async (predicate: (frame: any) => boolean) => {
        for (;;) {
          const value = await lines.next();
          if (value.done)
            throw new Error(
              `child closed before V4 frame; stderr bytes=${Buffer.concat(stderr).length}`,
            );
          const frame = JSON.parse(value.value);
          if (frame.method === "interaction/requestPermission" && frame.id !== undefined) {
            // Fake upstream fixture authorizes only the read-only tool; no broad auto-approval.
            assert.equal(frame.params?.toolName, "Read");
            child.stdin.write(
              JSON.stringify({ id: frame.id, result: { decision: "allow" } }) + "\n",
            );
            continue;
          }
          if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined) {
            child.stdin.write(
              JSON.stringify({
                id: frame.id,
                result: {
                  askUserQuestionAutoResolutionEnabled: true,
                  nativeSearchEnhancementsEnabled: false,
                  memoryEnabled: false,
                },
              }) + "\n",
            );
            continue;
          }
          if (predicate(frame)) return frame;
        }
      };
      let seq = 0;
      const command = async (type: string, sessionId: string | null, payload: object) => {
        const id = ++seq;
        child.stdin.write(
          JSON.stringify({
            id,
            method: V4_METHODS.command,
            params: {
              commandId: `fixture-${id}`,
              clientId: "fixture",
              sessionId,
              type,
              payload,
              issuedAt: Date.now(),
            },
          }) + "\n",
        );
        return next((frame) => frame.id === id);
      };
      try {
        await next(
          (frame) => frame.method === "startup/storageState" && frame.params.phase === "ready",
        );
        const created = await command("createSession", null, { workspaceId: cwd });
        assert.equal(
          created.result?.status,
          "accepted",
          `reason=${created.result?.reasonCode ?? "none"}; stderrBytes=${Buffer.concat(stderr).length}`,
        );
        const sessionId = created.result.result.sessionId as string;
        child.stdin.write(
          JSON.stringify({
            id: ++seq,
            method: V4_METHODS.conversationSubscribe,
            params: {
              topic: `conversation/${sessionId}`,
              connectionId: "fixture",
              clientMode: "desktop-continuous",
            },
          }) + "\n",
        );
        const subscribed = await next((frame) => frame.id === seq);
        assert.ok(subscribed.result?.ack?.subscriptionId);
        const observedPhases: string[] = [];
        const completedFrame = (frame: any) => {
          if (frame.method !== "v4/conversation/frame") return false;
          const payload = frame.params?.frame?.payload;
          const phases =
            payload?.kind === "snapshot"
              ? [payload.snapshot.control?.phase]
              : payload?.deltas
                  ?.filter((delta: any) => delta.op === "state.updated")
                  .map((delta: any) => delta.patch?.control?.phase);
          for (const phase of phases ?? []) if (phase) observedPhases.push(phase);
          return phases?.includes("completedSuccess") ?? false;
        };
        for (let turn = 1; turn <= 2; turn++) {
          const ack = await command("sendText", sessionId, { text: `fixture instruction ${turn}` });
          assert.equal(ack.result?.status, "accepted");
          // The subprocess may send notifications while the model executes; each turn must reach the real upstream.
          const deadline = Date.now() + 12000;
          while ((turn === 1 ? requests === 0 : !sawSecondPrompt) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 25));
          assert.ok(
            turn === 1 ? requests > 0 : sawSecondPrompt,
            `turn=${turn} requests=${requests}`,
          );
          // A real V4 terminal projection, not a delay, fences the next turn's admission.
          let terminalTimeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              next(completedFrame),
              new Promise<never>((_, reject) => {
                terminalTimeout = setTimeout(
                  () =>
                    reject(
                      new Error(
                        `terminal V4 projection missing: turn=${turn}; phases=${observedPhases.join(",")}; requests=${requests}`,
                      ),
                    ),
                  9000,
                );
              }),
            ]);
          } finally {
            if (terminalTimeout) clearTimeout(terminalTimeout);
          }
          if (turn === 1) await writeFile(fixturePath, "seed=amber\n");
        }
        const currentReadDeadline = Date.now() + 12000;
        while (!sawCurrentRead && Date.now() < currentReadDeadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(
          sawCurrentRead,
          true,
          `current turn did not read changed file; requests=${requests}`,
        );
        console.log(
          `native-fake-proof: modelRequests=${requests} readTools=2 terminalTurns=2 currentRead=true paidUsage=none`,
        );
      } finally {
        child.stdin.end();
        const exitCode = await new Promise<number | null>((resolve) => {
          let exitTimeout: ReturnType<typeof setTimeout>;
          child.once("exit", (code) => {
            clearTimeout(exitTimeout);
            resolve(code);
          });
          exitTimeout = setTimeout(() => child.kill(), 3000);
        });
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
        assert.equal(exitCode, 0, "native V4 owner must dispose and exit after stdio detach");
      }
    },
  );
}
