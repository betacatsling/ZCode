import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

type ModelRequest = { model?: string; messages?: unknown[] };
type FixtureMessage = { type: string; [key: string]: unknown };
type OwnedProcess = { wrapperPid: number; cliPid: number };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("close", closed);
      resolve(false);
    }, timeoutMs);
    const closed = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("close", closed);
  });
}

async function stopOwnedGroups(processes: readonly OwnedProcess[]): Promise<void> {
  if (process.platform === "win32") return;
  for (const { wrapperPid } of processes) {
    if (!isProcessAlive(wrapperPid)) continue;
    try {
      // 这些 PGID 由本测试的 ZCodeAgentProcessManager detached spawn 创建并从夹具回传。
      process.kill(-wrapperPid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

test(
  "real Core/CLI cold-boot join keeps pre-constructor and pre-READY ingress held until the same CLI ACK",
  { timeout: 120_000 },
  async () => {
    // 源码态 Pi Worker 以隔离工作区为 cwd 启动 `--import tsx`；夹具留在本仓库的忽略目录，
    // 仅为解析同一 checkout 的开发依赖，不使用其他 checkout 的产物或用户配置。
    const root = await mkdtemp(join(process.cwd(), ".tmp", "core-preinit-actual-"));
    let requests: ModelRequest[] = [];
    let phase = "seed";
    const requestPhases: string[] = [];
    const requestListeners = new Set<(request: ModelRequest) => void>();
    const upstream = createServer(async (request, response) => {
      if (request.url?.includes("/messages") !== true) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
      assert.equal(body.model, "fixture-model");
      requests.push(body);
      requestPhases.push(phase);
      for (const listener of requestListeners) listener(body);
      const event = (type: string, data: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" }).end(
        event("message_start", {
          message: {
            id: `msg_${requests.length}`,
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
            delta: { type: "text_delta", text: "fixture reply" },
          }) +
          event("content_block_stop", { index: 0 }) +
          event("message_delta", {
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 4 },
          }) +
          event("message_stop", {}),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");

    const configDir = join(root, ".zcode", "v2");
    await mkdir(configDir, { recursive: true });
    const provider = join(configDir, "provider_config.json");
    await writeFile(
      provider,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "fixture",
                providerName: "Fixture",
                enabled: true,
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "fixture-only-not-a-credential" },
                  api: {
                    type: "anthropic-messages",
                    baseUrl: `http://127.0.0.1:${address.port}/fixture`,
                  },
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
      }),
    );
    const builtin = join(root, "builtin.json");
    await writeFile(
      builtin,
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
    const layout = resolveServerLayout(join(root, "install"));
    await ensureServerInstallOwnership(layout);
    const pidDirectory = join(root, "owned-cli-pids");
    const earlyAckFile = join(root, "early-command-ack.json");
    const fixtureFile = fileURLToPath(
      new URL("./corePreinitActualChild.fixture.ts", import.meta.url),
    );
    const wrapperFile = fileURLToPath(
      new URL("./corePreinitActualCliWrapper.fixture.ts", import.meta.url),
    );
    let child: ChildProcess | undefined;
    let stderr = "";
    let failure: FixtureMessage | undefined;
    const messages: FixtureMessage[] = [];
    const waiters = new Set<{
      type: string;
      resolve: (message: FixtureMessage) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }>();
    const next = (type: string): Promise<FixtureMessage> => {
      const existingIndex = messages.findIndex((message) => message.type === type);
      if (existingIndex >= 0) return Promise.resolve(messages.splice(existingIndex, 1)[0]!);
      if (failure) return Promise.reject(new Error(JSON.stringify(failure)));
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Core fixture ${type} deadline; stderr=${stderr.slice(-2000)}`));
          }, 30_000),
        };
        waiters.add(waiter);
      });
    };
    const waitForModelRequest = (predicate: (request: ModelRequest) => boolean) => {
      const existing = requests.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<ModelRequest>((resolve, reject) => {
        const listener = (request: ModelRequest) => {
          if (!predicate(request)) return;
          requestListeners.delete(listener);
          clearTimeout(timer);
          resolve(request);
        };
        const timer = setTimeout(() => {
          requestListeners.delete(listener);
          reject(new Error(`fake Model request deadline; observed=${requests.length}`));
        }, 30_000);
        requestListeners.add(listener);
      });
    };

    try {
      child = fork(fixtureFile, [], {
        cwd: root,
        execArgv: ["--import", import.meta.resolve("tsx")],
        env: {
          PATH: process.env.PATH ?? "",
          NODE_OPTIONS: "--max-old-space-size=2048",
          HOME: root,
          XDG_CONFIG_HOME: root,
          ZCODE_DATA_BASE_DIR: root,
          ZCODE_SERVER_ROOT: layout.serverRoot,
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
          ZCODE_SESSION_DB_PATH: join(root, "native.sqlite"),
          ZCODE_TELEMETRY_ENABLED: "false",
          ZCODE_MULTI_HARNESS_ENABLED: "1",
          ZCODE_AGENT_SERVER_REQUIRES_STORAGE_STARTUP: "1",
          ZCODE_AGENT_SERVER_BOOT_FENCE_V1: "1",
          ZCODE_AGENT_SERVER_COMMAND: process.execPath,
          ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
            "--import",
            import.meta.resolve("tsx"),
            wrapperFile,
          ]),
          CORE_PREINIT_TSX_LOADER: import.meta.resolve("tsx"),
          CORE_PREINIT_EARLY_ACK_FILE: earlyAckFile,
          CORE_PREINIT_CLI_PID_DIR: pidDirectory,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        if (stderr.length > 12_000) stderr = stderr.slice(-12_000);
      });
      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object" || !("type" in raw)) return;
        const message = raw as FixtureMessage;
        if (message.type === "failure") {
          failure = message;
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(
              new Error(
                `${JSON.stringify(message)}; stages=${JSON.stringify(messages)}; model-requests=${JSON.stringify(requests.map((request, index) => ({ index, phase: requestPhases[index], messages: request.messages })))}; stderr-start=${stderr.slice(0, 1000)}; stderr-end=${stderr.slice(-1000)}`,
              ),
            );
          }
          waiters.clear();
          return;
        }
        const waiter = [...waiters].find((candidate) => candidate.type === message.type);
        if (waiter) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else messages.push(message);
      });
      child.once("exit", (code, signal) => {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(
            new Error(`Core fixture exited ${code}/${signal}; stderr=${stderr.slice(-2000)}`),
          );
        }
        waiters.clear();
      });

      const seeded = await next("seeded");
      phase = "seed-completed";
      assert.equal(seeded.createStatus, "accepted");
      assert.equal(seeded.inputStatus, "accepted");
      assert.equal(
        seeded.seedTurnTerminal,
        true,
        "ordinary seed input must finish before cold reopen",
      );
      assert.equal(seeded.persistedNativeSessions, 1);
      const seedRequest = await waitForModelRequest((request) =>
        JSON.stringify(request.messages).includes("ordinary input before cold reopen"),
      );
      assert.equal(seedRequest.model, "fixture-model");
      phase = "seed-shutdown";
      child.send("finish-seed");
      const closed = await next("seed-closed");
      assert.equal(closed.persistedNativeSessions, 1);
      // 种子 turn 完成后仍可能发起标题等合法后台 Model 请求；以真实 CLI 关闭为冷启动基线。
      const seedRequestCount = requests.length;
      const seededInputRequestCount = requests.filter((request) =>
        JSON.stringify(request.messages).includes("ordinary input before cold reopen"),
      ).length;
      const openPids = JSON.parse(
        await readFile(join(pidDirectory, "open-cli.json"), "utf8"),
      ) as OwnedProcess;
      assert.ok(openPids.cliPid > 0 && openPids.wrapperPid > 0);
      assert.equal(
        isProcessAlive(openPids.cliPid),
        false,
        "seed CLI process must close before cold boot",
      );
      assert.equal(
        isProcessAlive(openPids.wrapperPid),
        false,
        "seed wrapper process must close before cold boot",
      );

      phase = "core-cold-boot";
      child.send("start-core");
      const reconciled = await next("authority-reconciled");
      phase = "core-held-before-ready";
      assert.equal(reconciled.corePublication, "not-yet-ready");
      assert.equal(
        reconciled.admissionEnabled,
        false,
        "Catalog reconciliation must not open admission",
      );
      assert.equal(
        reconciled.persistedNativeSessions,
        1,
        "cold open preserves real public session",
      );
      const early = reconciled.earlyAck as {
        cliPid?: number;
        id?: string;
        errorMessage?: string | null;
        result?: { status?: string; reasonCode?: string } | null;
      };
      assert.equal(early.id, "core-preinit-early-v4-probe");
      assert.ok(
        (early.cliPid ?? 0) > 0,
        "the actual CLI subprocess received the pre-constructor frame",
      );
      assert.equal(early.result?.status, "rejected");
      assert.equal(early.result?.reasonCode, "guard.nativeMaintenanceFrozen");
      const coldCommand = reconciled.coldCommand as {
        results?: Array<{ result?: { status?: string } | "unknown" }>;
      };
      assert.equal(
        coldCommand.results?.length,
        1,
        "the prior input was observed through public readonly query",
      );
      const coldResult = coldCommand.results?.[0]?.result;
      assert.equal(
        typeof coldResult === "object" ? coldResult?.status : coldResult,
        "accepted",
        `cold public query must recover the ordinary accepted input, got ${JSON.stringify(coldResult)}`,
      );
      assert.equal(
        requests.length,
        seedRequestCount,
        `cold boot must not execute Model work while held; ${JSON.stringify(
          requests.map((request, index) => ({
            index,
            seedInput: JSON.stringify(request.messages).includes(
              "ordinary input before cold reopen",
            ),
            heldProbe: JSON.stringify(request.messages).includes(
              "this actual V4 input must stay held",
            ),
            releasedSend: JSON.stringify(request.messages).includes("Answer briefly without tools"),
            phase: requestPhases[index],
          })),
        )}`,
      );

      assert.equal(
        requests.filter((request) =>
          JSON.stringify(request.messages).includes("ordinary input before cold reopen"),
        ).length,
        seededInputRequestCount,
        "cold CLI readonly query must not replay the prior accepted input",
      );
      child.send("probe-held");
      const held = await next("held-probe");
      assert.equal(held.availabilityEnabled, false);
      assert.equal(held.hostRefused, true, String(held.hostError));
      const nativeResult = held.nativeResult as {
        status?: string;
        reasonCode?: string;
        error?: string;
      };
      assert.ok(
        (nativeResult.status === "rejected" &&
          nativeResult.reasonCode === "guard.nativeMaintenanceFrozen") ||
          /guard\.nativeMaintenanceFrozen/.test(nativeResult.error ?? ""),
        JSON.stringify(nativeResult),
      );
      assert.equal(held.nativeSessionsBefore, 1);
      assert.equal(held.nativeSessionsAfter, 1);
      assert.equal(
        requests.length,
        seedRequestCount,
        "held native/Host input must have no Model effect",
      );

      child.send("publish-ready");
      const ready = await next("ready");
      assert.equal(ready.generation, 1);
      assert.ok(typeof ready.host === "string" && typeof ready.port === "number");
      const infoResponse = await fetch(`http://${ready.host}:${ready.port}/api/server-info`);
      assert.equal(infoResponse.status, 200);
      assert.equal((await infoResponse.json()).capabilities.agentHost, true);

      child.send("release");
      const joined = await next("joined");
      assert.equal(joined.releaseAck, true, "same boot lease awaited the real CLI release ACK");
      assert.equal(joined.created, "boot-host");
      assert.equal(joined.receipt, "accepted");
      assert.ok((joined.eventKinds as string[]).includes("turn.finished"));
      assert.equal(joined.workspaceId, "workspace");
      const postReleaseRequest = await waitForModelRequest(
        (_request) => requests.length > seedRequestCount,
      );
      assert.equal(postReleaseRequest.model, "fixture-model");
      assert.equal(requests.length, seedRequestCount + 1);

      child.send({ command: "shutdown" });
      const disposed = await next("disposed-release");
      assert.equal(disposed.rejected, true, "a disposed boot owner cannot release stale admission");
      assert.equal(
        await waitForExit(child, 10_000),
        true,
        `Core did not stop: ${stderr.slice(-2000)}`,
      );
      assert.equal(child.exitCode, 0);
      const heldPids = JSON.parse(
        await readFile(join(pidDirectory, "held-cli.json"), "utf8"),
      ) as OwnedProcess;
      assert.ok(heldPids.cliPid > 0 && heldPids.wrapperPid > 0);
      assert.equal(
        isProcessAlive(heldPids.cliPid),
        false,
        "same selected CLI must be disposed at Core stop",
      );
      assert.equal(
        isProcessAlive(heldPids.wrapperPid),
        false,
        "same selected CLI wrapper must be disposed at Core stop",
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.disconnect();
        await waitForExit(child, 10_000);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      }
      const owned: OwnedProcess[] = [];
      for (const name of ["open-cli.json", "held-cli.json"]) {
        try {
          owned.push(JSON.parse(await readFile(join(pidDirectory, name), "utf8")) as OwnedProcess);
        } catch {
          // A failure before spawn leaves no owned PID for this phase.
        }
      }
      await stopOwnedGroups(owned);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
