import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  realpath,
  access,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import {
  matchingFinalAnswer,
  matchingTerminal,
  nativeEvidenceRows,
  permittedFixtureAction,
} from "./native-private-evidence.js";
import { createPrivateObservation } from "./native-private-observer.js";
import { createPrivateNoopLoggerFactory } from "./native-private-logger.js";
import { createPrivateEffectPorts } from "./native-private-effects.js";
import { PRIVATE_SHELL_SCRIPT, privateShellCommand } from "./native-private-shell-fixture.js";

const childMode = process.env.ZCODE_NATIVE_BOOT_FIXTURE_CHILD === "1";
if (childMode) {
  const { runZCodeProtocolAgent } = await import("./zcode-protocol-entrypoint.js");
  const { AiSdkModelAdapter } = await import("@zcode/adapters/model");
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
              access: new ApiKeyAccessConfig({ apiKey: "fixture-private-key-sentinel" }),
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
  const observation = createPrivateObservation({
    providerId: "fixture",
    modelId: "fixture-model",
    api: "anthropic-messages",
    baseUrl: process.env.ZCODE_BOOT_FIXTURE_URL!,
    fetch: globalThis.fetch.bind(globalThis),
    allowedToolNames: ["Read", "Write", "Bash"],
    notify: () => {},
  });
  const cwd = process.env.ZCODE_BOOT_FIXTURE_CWD!;
  const effects = createPrivateEffectPorts({
    cwd,
    readPath: join(cwd, "input.txt"),
    writePath: join(cwd, "output.txt"),
    writeContent: "allowed-write-content",
    bashCommand: privateShellCommand(process.execPath),
    processEnv: process.env,
  });
  process.on("message", (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "kind" in message &&
      "phase" in message &&
      message.kind === "private-phase" &&
      [1, 2, 3].includes(Number(message.phase))
    ) {
      effects.setPhase(Number(message.phase) as 1 | 2 | 3);
      process.send?.({ kind: "private-phase-ready", phase: message.phase });
    }
  });
  try {
    await runZCodeProtocolAgent(
      {
        cwd,
        env: process.env,
        input: process.stdin,
        output: process.stdout,
      },
      {
        loggerFactory: createPrivateNoopLoggerFactory(),
        fileSystemPort: effects.fileSystemPort,
        executionPort: effects.executionPort,
        modelAdapter: new AiSdkModelAdapter({
          env: {},
          retry: { maxAttempts: 1 },
          onModelCall: observation.onModelCall,
          transport: observation.transport,
        }),
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
  } finally {
    await effects.dispose();
  }
  process.stderr.write(
    `native-observation:${observation.counts.httpAttempts}:${observation.counts.modelCalls}\n`,
  );
} else {
  test(
    "native V4 matrix uses real Registry/Model: Read, denied/allowed Write, Bash and post-terminal fresh Read",
    { timeout: 40000 },
    async () => {
      // 修复：macOS /var 是 /private/var 链接；已知 fixture 的脚本须在 canonical cwd 中验证。
      const root = await realpath(await mkdtemp(join(tmpdir(), "native-boot-v4-")));
      const cwd = join(root, "worktree");
      await mkdir(cwd);
      const fixturePath = join(cwd, "input.txt");
      await writeFile(fixturePath, "seed=violet\n");
      const writePath = join(cwd, "output.txt");
      const bashPath = join(cwd, "bash-effect.txt");
      await writeFile(join(cwd, "verify.cjs"), PRIVATE_SHELL_SCRIPT);
      const bashCommand = privateShellCommand(process.execPath);
      const changedContent = "seed=amber-unknown-until-turn-three";
      let requests = 0;
      let sawCurrentRead = false;
      let finalAnswerSent = false;
      let bashResultSeen = false;
      let finalAnswerObserved = false;
      let terminalCommandId = "";
      let currentTurn = 0;
      let activeSessionId = "";
      const observedRows: Array<{
        kind?: string;
        turnId?: string;
        state?: string;
        text?: string;
        sourceCommandId?: string;
      }> = [];
      let deniedWrites = 0;
      let allowedWrites = 0;
      let bashApprovals = 0;
      const routeCounts = [0, 0, 0];
      const upstream = createServer(async (request, response) => {
        requests++;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        // Only derive a boolean from disposable fixture text; never retain request, URL or headers.
        const body = Buffer.concat(chunks);
        const turn = body.includes(Buffer.from("fixture instruction 3"))
          ? 2
          : body.includes(Buffer.from("fixture instruction 2"))
            ? 1
            : 0;
        const step = routeCounts[turn]++;
        if (turn === 2 && step > 0) sawCurrentRead = body.includes(Buffer.from(changedContent));
        if (turn === 1 && step === 2) {
          const decoded = body.toString();
          const containsExactCommand = (value: unknown): boolean =>
            typeof value === "string"
              ? value.includes(bashCommand)
              : Array.isArray(value)
                ? value.some(containsExactCommand)
                : value !== null && typeof value === "object"
                  ? Object.values(value).some(containsExactCommand)
                  : false;
          bashResultSeen = decoded.includes("exit=0") && containsExactCommand(JSON.parse(decoded));
        }
        const tool =
          turn === 0
            ? [
                { name: "Read", input: { file_path: fixturePath } },
                {
                  name: "Write",
                  input: { file_path: writePath, content: "allowed-write-content" },
                },
              ][step]
            : turn === 1
              ? [
                  {
                    name: "Write",
                    input: { file_path: writePath, content: "allowed-write-content" },
                  },
                  { name: "Bash", input: { command: bashCommand } },
                ][step]
              : step === 0
                ? { name: "Read", input: { file_path: fixturePath } }
                : undefined;
        if (turn === 2 && !tool) finalAnswerSent = sawCurrentRead;
        const event = (type: string, data: object) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        const text =
          turn === 2 && sawCurrentRead
            ? `Final read: ${changedContent}`
            : `fixture-turn-${turn + 1}`;
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
                    name: tool.name,
                    input: {},
                  },
                }) +
                event("content_block_delta", {
                  index: 0,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(tool.input),
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
            SHELL: "/bin/bash",
            PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
            ZCODE_DATA_BASE_DIR: root,
            ZCODE_SESSION_DB_PATH: "session.sqlite",
            ZCODE_NATIVE_BOOT_FIXTURE_CHILD: "1",
            ZCODE_BOOT_FIXTURE_CWD: cwd,
            ZCODE_BOOT_FIXTURE_URL: `http://127.0.0.1:${address.port}/fixture-private-endpoint-sentinel`,
            ZCODE_TELEMETRY_ENABLED: "false",
          },
          stdio: ["pipe", "pipe", "pipe", "ipc"],
        },
      );
      assert.ok(child.stdin && child.stdout && child.stderr, "native fixture stdio unavailable");
      const stdin = child.stdin;
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
          assert.ok(
            !value.value.includes("fixture-private-key-sentinel") &&
              !value.value.includes("fixture-private-endpoint-sentinel"),
            "V4 launch output leaked fixture credential",
          );
          const frame = JSON.parse(value.value);
          if (frame.method === "interaction/requestPermission" && frame.id !== undefined) {
            const toolName = frame.params?.toolName;
            assert.ok(["Read", "Write", "Bash"].includes(toolName), `unexpected tool=${toolName}`);
            const decision = permittedFixtureAction({
              toolName,
              params: frame.params?.input,
              cwd,
              readPath: fixturePath,
              writePath,
              writeContent: "allowed-write-content",
              bashCommand,
              phase: currentTurn,
              deniedWrites,
            });
            if (decision === "deny" && toolName !== "Write")
              throw new Error("unapproved tool input");
            if (toolName === "Write") {
              if (currentTurn === 1) {
                await assert.rejects(access(writePath));
                deniedWrites++;
                assert.equal(decision, "deny");
              } else {
                await assert.rejects(access(writePath));
                assert.equal(decision, "allow");
                allowedWrites++;
              }
            } else if (toolName === "Bash") {
              assert.equal(await readFile(writePath, "utf8"), "allowed-write-content");
              assert.equal(decision, "allow");
              bashApprovals++;
            } else assert.equal(decision, "allow");
            stdin.write(JSON.stringify({ id: frame.id, result: { decision } }) + "\n");
            continue;
          }
          if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined) {
            stdin.write(
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
          observedRows.push(...nativeEvidenceRows(frame, activeSessionId));
          if (terminalCommandId) {
            const turnId = matchingTerminal(observedRows, terminalCommandId);
            if (turnId)
              finalAnswerObserved = matchingFinalAnswer(observedRows, turnId, changedContent);
          }
          if (predicate(frame)) return frame;
        }
      };
      let seq = 0;
      const command = async (type: string, sessionId: string | null, payload: object) => {
        const id = ++seq;
        stdin.write(
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
        activeSessionId = sessionId;
        stdin.write(
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
        const completedFrame = (_frame: unknown) =>
          matchingTerminal(observedRows, terminalCommandId) !== undefined;
        for (let turn = 1; turn <= 3; turn++) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("fixture phase fence missing")), 3000);
            const onPhase = (message: unknown) => {
              if (
                !message ||
                typeof message !== "object" ||
                !("kind" in message) ||
                !("phase" in message) ||
                message.kind !== "private-phase-ready" ||
                message.phase !== turn
              )
                return;
              clearTimeout(timer);
              child.off("message", onPhase);
              resolve();
            };
            child.on("message", onPhase);
            child.send({ kind: "private-phase", phase: turn });
          });
          currentTurn = turn;
          terminalCommandId = `fixture-${seq + 1}`;
          const ack = await command("sendText", sessionId, { text: `fixture instruction ${turn}` });
          assert.equal(ack.result?.status, "accepted");
          // The subprocess may send notifications while the model executes; each turn must reach the real upstream.
          const deadline = Date.now() + 12000;
          while (routeCounts[turn - 1] === 0 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 25));
          assert.ok(routeCounts[turn - 1] > 0, `turn=${turn} requests=${requests}`);
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
                        `terminal V4 projection missing: turn=${turn}; requests=${requests}`,
                      ),
                    ),
                  9000,
                );
              }),
            ]);
          } finally {
            if (terminalTimeout) clearTimeout(terminalTimeout);
          }
          assert.ok(
            routeCounts[turn - 1]! >= (turn === 3 ? 2 : 3),
            `terminal did not follow this turn's Model continuation: turn=${turn}`,
          );
          if (turn === 1) {
            assert.equal(deniedWrites, 1);
            await assert.rejects(access(writePath));
          }
          if (turn === 2) {
            assert.equal(allowedWrites, 1);
            assert.equal(bashApprovals, 1);
            assert.equal(await readFile(writePath, "utf8"), "allowed-write-content");
            assert.equal(await readFile(bashPath, "utf8"), `bash-verified|${process.execPath}`);
          }
          // 外部变更只能发生在第二轮真实 terminal 之后，不能由旧聚合上下文冒充。
          if (turn === 2) await writeFile(fixturePath, changedContent);
        }
        const currentReadDeadline = Date.now() + 12000;
        while (!sawCurrentRead && Date.now() < currentReadDeadline)
          await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(
          sawCurrentRead,
          true,
          `current turn did not read changed file; requests=${requests}`,
        );
        assert.equal(finalAnswerSent, true);
        assert.equal(finalAnswerObserved, true);
        assert.equal(
          bashResultSeen,
          true,
          "Bash command/result must be present in model continuation",
        );
        assert.ok(routeCounts[0] >= 3 && routeCounts[0] <= 4);
        assert.deepEqual(routeCounts.slice(1), [3, 2]);
        assert.ok(requests <= 12, `fake native route exceeded request budget: ${requests}`);
        console.log(
          `native-fake-proof: upstreamHttpRequests=${requests} modelCallCounter=observed readTools=3 deniedWrites=${deniedWrites} allowedWrites=${allowedWrites} bashApprovals=${bashApprovals} terminalTurns=3 currentRead=true finalAnswer=true paidUsage=none`,
        );
      } catch (error) {
        const failureLine =
          error instanceof Error
            ? error.stack?.split("\n")[1]?.replace(process.cwd(), "[repo]")
            : "unknown";
        console.log(
          `native-fake-stage: requests=${requests} turn=${currentTurn} ackSeq=${seq} stderrBytes=${Buffer.concat(stderr).length} at=${failureLine}`,
        );
        throw new Error(
          "native fake scenario failed before terminal/effects; private child output withheld",
        );
      } finally {
        stdin.end();
        child.disconnect();
        const exitCode = await new Promise<number | null>((resolve) => {
          let exitTimeout: ReturnType<typeof setTimeout>;
          child.once("exit", (code) => {
            clearTimeout(exitTimeout);
            resolve(code);
          });
          exitTimeout = setTimeout(() => child.kill(), 3000);
        });
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        try {
          const stderrText = Buffer.concat(stderr).toString();
          const observation = /native-observation:(\d+):(\d+)/.exec(stderrText);
          if (requests > 0) {
            assert.equal(
              Number(observation?.[1]),
              requests,
              "transport attempts must match fake upstream",
            );
            assert.ok(Number(observation?.[2]) > 0, "Model calls are measured independently");
          }
          const secrets = ["fixture-private-key-sentinel", "fixture-private-endpoint-sentinel"];
          const scan = async (directory: string): Promise<number> => {
            let files = 0;
            for (const item of await readdir(directory, { withFileTypes: true })) {
              const path = join(directory, item.name);
              if (item.isDirectory()) files += await scan(path);
              else if (item.isFile()) {
                const data = await readFile(path);
                assert.ok(
                  secrets.every((secret) => !data.includes(Buffer.from(secret))),
                  `private artifact scan failed in ${item.name}: ${data.includes(Buffer.from(secrets[0]!)) ? "credential" : "endpoint"}`,
                );
                files++;
              }
            }
            return files;
          };
          const scanned = await scan(root);
          assert.ok(
            secrets.every((secret) => !stderrText.includes(secret)),
            "child output scan failed",
          );
          console.log(`native-fake-private-scan: passed files=${scanned}`);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
        assert.equal(exitCode, 0, "native V4 owner must dispose and exit after stdio detach");
      }
    },
  );
}
