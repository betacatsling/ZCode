// Explicit opt-in: node --import tsx packages/services/test/fixtures/probeCodexModelGateway.mjs
// Starts a real Codex app-server against only an isolated loopback Model Gateway and Fake Model.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelGateway, MODEL_GATEWAY_VERSION } from "../../src/model-gateway/index.ts";
import { createFakeCodexGatewayModel } from "./fakeCodexGatewayModel.mjs";

if (process.env.ZCODE_CODEX_GATEWAY_PROBE !== "1")
  throw new Error("explicit probe opt-in required");

const cliVersion = "codex-cli 0.157.1";
const root = await mkdtemp(join(tmpdir(), "zcode-codex-model-gateway-"));
const codexHome = join(root, "codex-home");
const runtimeTmp = join(root, "runtime-tmp");
await mkdir(codexHome, { mode: 0o700 });
await mkdir(runtimeTmp, { mode: 0o700 });
for (const directory of [
  ".tmp",
  "sessions",
  "shell_snapshots",
  "skills",
  "thread-writer-locks",
  "tmp",
]) {
  await mkdir(join(codexHome, directory), { mode: 0o700 });
}
let gatewayToken = "";
let childStderr = "";
const toolCommand = "printf local-only > gateway-roundtrip.txt";
const {
  model: fakeModel,
  modelTrace,
  cancellationStarted,
  cancellationObserved,
} = createFakeCodexGatewayModel(toolCommand);

const gateway = createModelGateway({
  targetId: "probe-target",
  host: "127.0.0.1",
  port: 0,
  maxConcurrent: 2,
});
let child;
let childExited;
const childEnv = {
  PATH: process.env.PATH ?? (process.platform === "win32" ? "" : "/usr/bin:/bin"),
  HOME: root,
  CODEX_HOME: codexHome,
  TMPDIR: runtimeTmp,
  TMP: runtimeTmp,
  TEMP: runtimeTmp,
  XDG_RUNTIME_DIR: runtimeTmp,
  LANG: "C.UTF-8",
};
const executablePath = process.env.ZCODE_CODEX_EXECUTABLE || "codex";
try {
  const version = spawnSync(executablePath, ["--version"], { encoding: "utf8", env: childEnv });
  assert.equal(version.status, 0, "Codex version probe must succeed in the isolated profile");
  assert.equal(
    version.stdout.trim(),
    cliVersion,
    "probe CLI must match its explicit compatibility row",
  );
  const gatewayAddress = await gateway.start();
  const grant = gateway.createGrant({
    sessionId: "probe-session",
    modelBindingFingerprint: "fake-binding-v1",
    publicModelId: "fixture-model",
    model: fakeModel,
    expiresInMs: 5 * 60_000,
    limits: {
      maxBodyBytes: 512_000,
      maxRequests: 12,
      maxConcurrent: 2,
      maxOutputTokens: 32_000,
      maxOutputTokensPerRequest: 8_000,
    },
  });
  gatewayToken = grant.token;
  const args = [
    "app-server",
    "--stdio",
    "--strict-config",
    "--disable",
    "multi_agent",
    "-c",
    'model_providers.zcode.name="ZCode loopback fixture"',
    "-c",
    'model_providers.zcode.base_url="' + gatewayAddress.baseUrl + '/v1"',
    "-c",
    'model_providers.zcode.env_key="ZCODE_CODEX_GATEWAY_TOKEN"',
    "-c",
    'model_providers.zcode.wire_api="responses"',
    "-c",
    'web_search="disabled"',
  ];
  child = spawn(executablePath, args, {
    cwd: root,
    env: {
      ...childEnv,
      ZCODE_CODEX_GATEWAY_TOKEN: grant.token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  const pending = new Map();
  const notifications = [];
  const waiters = [];
  let nextId = 0;
  childExited = new Promise((resolve) => child.once("exit", resolve));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    childStderr = (childStderr + chunk).slice(-4096);
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) break;
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const settled = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) settled.reject(new Error(JSON.stringify(message.error)));
        else settled.resolve(message.result);
        continue;
      }
      if (message.method) {
        const entry = { method: message.method, params: message.params ?? {} };
        notifications.push(entry);
        for (let waiterIndex = waiters.length - 1; waiterIndex >= 0; waiterIndex--) {
          const waiter = waiters[waiterIndex];
          if (
            notifications.length - 1 >= waiter.afterIndex &&
            waiter.method === entry.method &&
            waiter.predicate(entry.params)
          ) {
            waiters.splice(waiterIndex, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(entry.params);
          }
        }
        if (message.id !== undefined) {
          child.stdin.write(
            JSON.stringify({
              id: message.id,
              error: { code: -32601, message: "isolated probe does not authorize server requests" },
            }) + "\n",
          );
        }
      }
    }
  });
  child.once("exit", (code) => {
    for (const request of pending.values())
      request.reject(new Error("Codex app-server exited (" + code + ")"));
    pending.clear();
  });

  const rpc = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  };
  const waitForNotification = (method, predicate = () => true, afterIndex = 0) => {
    const found = notifications
      .slice(afterIndex)
      .find((entry) => entry.method === method && predicate(entry.params));
    if (found) return Promise.resolve(found.params);
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: undefined, afterIndex };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error("timed out waiting for " + method));
      }, 25_000);
      waiters.push(waiter);
    });
  };

  await rpc("initialize", {
    clientInfo: {
      name: "zcode-model-gateway-probe",
      title: "ZCode Gateway probe",
      version: MODEL_GATEWAY_VERSION,
    },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const started = await rpc("thread/start", {
    model: "fixture-model",
    modelProvider: "zcode",
    cwd: root,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    baseInstructions: "Follow the user's request exactly.",
  });
  const threadId = started?.thread?.id ?? started?.threadId;
  assert.ok(threadId, "thread/start must return a thread id");

  async function runTurn(text, expectedStatus = "completed") {
    const completion = waitForNotification(
      "turn/completed",
      (params) => params.threadId === threadId,
      notifications.length,
    );
    await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text }],
      effort: "none",
      summary: "none",
    });
    const params = await completion;
    const status = params.turn?.status;
    if (status !== expectedStatus) {
      const errors = notifications
        .filter((entry) => entry.method === "error")
        .map((entry) => ({
          paramKeys: Object.keys(entry.params),
          code: entry.params.error?.code,
          message:
            typeof entry.params.error?.message === "string"
              ? entry.params.error.message.slice(0, 300).replaceAll(gatewayToken, "<redacted>")
              : undefined,
        }));
      console.error(
        JSON.stringify({
          turnStatus: status,
          turnErrorCode: params.turn?.error?.code,
          turnErrorMessage:
            typeof params.turn?.error?.message === "string"
              ? params.turn.error.message.slice(0, 300).replaceAll(gatewayToken, "<redacted>")
              : undefined,
          errors,
          modelTrace,
        }),
      );
    }
    assert.equal(status, expectedStatus);
    return params;
  }

  await runTurn("Say exactly: gateway text ok.");
  await runTurn("Please invoke the local fixture writer once.");
  const completedCommand = notifications.find(
    (entry) =>
      entry.params.item?.type === "commandExecution" && entry.params.item.status === "completed",
  );
  assert.equal(
    completedCommand?.params.item?.exitCode,
    0,
    "temporary tool command must exit successfully",
  );
  assert.equal(
    completedCommand?.params.item?.cwd,
    root,
    "Codex tool cwd must be the temporary workspace",
  );
  assert.equal(await readFile(join(root, "gateway-roundtrip.txt"), "utf8"), "local-only");
  const cancellationCompletion = waitForNotification(
    "turn/completed",
    (params) => params.threadId === threadId,
    notifications.length,
  );
  const cancellationStart = await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "Please wait until interrupted." }],
    effort: "none",
    summary: "none",
  });
  const turnId = cancellationStart?.turn?.id ?? cancellationStart?.turnId;
  assert.ok(turnId, "turn/start must return a turn id for interruption");
  await cancellationStarted;
  await rpc("turn/interrupt", { threadId, turnId });
  const cancelled = await cancellationCompletion;
  assert.ok(["interrupted", "cancelled"].includes(cancelled.turn?.status));
  await cancellationObserved;
  assert.deepEqual(
    modelTrace.map((entry) => entry.kind),
    ["text", "tool-call", "tool-result", "cancel"],
  );
  assert.ok(modelTrace.every((entry) => entry.abortSignalPassed));
  const notificationNames = notifications.map((entry) => entry.method);
  assert.ok(notificationNames.includes("item/completed"));
  assert.ok(notificationNames.includes("thread/tokenUsage/updated"));
  assert.ok(notificationNames.includes("turn/completed"));
  console.log(
    JSON.stringify({
      probe: "codex-model-gateway",
      codexCliVersion: cliVersion,
      gatewayVersion: MODEL_GATEWAY_VERSION,
      endpoint: "/v1/responses",
      listener: "127.0.0.1 loopback only",
      externalProviderOrApi: false,
      credentialProfileCopied: false,
      toolWorkspace: "temporary isolated workspace",
      toolWriteVerified: true,
      sandboxMode: "danger-full-access",
      sandboxReason:
        "workspace-write failed because the local bubblewrap app-server socket directory did not satisfy its 0700 ownership check",
      modelTrace,
      turnStatuses: notifications
        .filter((entry) => entry.method === "turn/completed")
        .map((entry) => entry.params.turn?.status),
      appServerNotifications: [...new Set(notificationNames)].sort(),
      appServerControl: ["initialize", "thread/start", "turn/start", "turn/interrupt"],
      cancellationObserved: true,
    }),
  );
} catch (error) {
  const errorText = String(error);
  const safeError = gatewayToken ? errorText.replaceAll(gatewayToken, "<redacted>") : errorText;
  console.error(
    JSON.stringify({
      probe: "codex-model-gateway",
      error: safeError,
      stderrPresent: childStderr.length > 0,
    }),
  );
  throw error;
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([childExited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await gateway.close();
  await rm(root, { recursive: true, force: true });
}
