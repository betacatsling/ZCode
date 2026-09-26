#!/usr/bin/env node
/* eslint-disable max-lines -- Keep the bounded native controller's permission/effect/finalization ordering together. */
// No implicit paid calls. Fake and live share the same native V4 lifecycle and cleanup.
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPrivateChannel } from "./native-private-channel.mjs";
import { startPrivateFake } from "./native-private-fake.mjs";
import { assertAbsent } from "./native-private-artifacts.mjs";
import {
  matchingFinalAnswer,
  matchingTerminal,
  matchingTool,
  nativeEvidenceRows,
  permittedFixtureAction,
  isExactFixtureAction,
} from "../apps/zcode-cli/packages/bootstrap/src/native-private-evidence.ts";
import { removeBounded } from "./native-private-cleanup.mjs";
import { createPrivateUsage } from "./native-private-usage.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const routes = new Set(["stepfun/step-3.5-flash", "axonhub/deepseek-v4-flash"]);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(
    "Usage: node --import tsx scripts/native-private-runner.mjs [--fake | --live stepfun/step-3.5-flash | --live axonhub/deepseek-v4-flash]",
  );
} else if (args.length === 0 || (args.length === 1 && args[0] === "--fake")) {
  await run("fake");
} else if (args.length === 2 && args[0] === "--live" && routes.has(args[1])) {
  await run(args[1]);
} else {
  console.error("invalid route/mode; use --help");
  process.exitCode = 2;
}

async function run(route) {
  const deadlineAt = Date.now() + 240_000;
  const disposable = await realpath(
    await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "np-")),
  );
  const cwd = join(disposable, "worktree");
  const readPath = join(cwd, "input.txt");
  const writePath = join(cwd, "output.txt");
  const bashPath = join(cwd, "bash-effect.txt");
  const writeContent = `approved-${randomUUID()}`;
  let changedContent;
  const bashCommand = "node verify.cjs";
  const trustedNode = process.execPath;
  if (!process.version.startsWith("v24."))
    throw new Error("private fixture requires pinned Node 24");
  const fake = route === "fake";
  const report = {
    mode: fake ? "fake" : "live",
    route: fake ? "fixture" : route,
    session: "scoped",
    turns: [],
    ack: 0,
    matchingTerminals: 0,
    modelCalls: { stream: 0, generate: 0 },
    httpAttempts: 0,
    httpDispatches: 0,
    usage: null,
    modelUsageCalls: [],
    usageCoverage: { main: "unknown", auxiliary: "unknown" },
    modelCountAttribution: "unknown",
    httpCountAttribution: "global-only",
    usageQualified: false,
    auxiliaryCompletedAfterNewTurn: false,
    childExit: null,
    effects: { deniedWrite: false, allowedWrite: false, bash: false, freshReadAnswer: false },
    privateArtifactScan: false,
    beforeEffectFileAbsent: null,
    scannedFiles: 0,
    forbiddenToolRequests: 0,
    cleanup: false,
    scenarioVerified: false,
    failureStage: null,
  };
  let channel, upstream, softTimer, fault;
  let failure = false,
    finalCounts,
    phaseReady,
    sessionId = "",
    sequence = 0,
    phase = 0,
    turnId;
  let deniedWrites = 0;
  let pendingIdentity = false;
  const nativePermissions = new Map();
  const seenNativeRequestIds = new Set();
  let permissionWake;
  const rows = new Map();
  let evidenceOrdinal = 0;
  const counts = { model: 0, http: 0, dispatch: 0 };
  const usage = createPrivateUsage();
  try {
    await mkdir(cwd);
    await writeFile(readPath, "seed=violet\n");
    await writeFile(join(cwd, "approved-content.txt"), writeContent);
    await writeFile(
      join(cwd, "verify.cjs"),
      "require('node:fs').writeFileSync('bash-effect.txt', 'bash-verified|' + process.execPath); console.log('exit=0')\n",
    );
    fault =
      fake &&
      [
        "webfetch",
        "webfetch-exposed",
        "other-tool",
        "agent-compact",
        "task-multiline",
        "workflow-compact",
        "wrong-write",
        "extra-cwd",
        "stale-session",
        "stale-call",
        "stale-turn",
        "usage-zero",
        "usage-absent",
        "aux-interleave",
        "fresh-foreign-turn",
        "fresh-foreign-call-before-row",
        "fresh-foreign-request-before-row",
        "foreign-native-command",
        "foreign-native-session",
        "foreign-native-turn",
        "wrong-model-body",
        "missing-tokens",
        "oversized-tokens",
        "wrong-query",
        "wrong-method",
        "wrong-route",
        "endpoint-leak",
        "unsolicited-outcome",
        "old-row",
        "hang-scan",
        "hang-cleanup",
        "wrong-bash",
        "shell-profile",
        "shell-override",
        "inherited-path",
        "no-read",
        "wrong-read",
        "echo-500",
        "error-200",
        "broken-sse",
        "chunked-oversize-json",
        "truncated-sse",
      ].includes(process.env.ZCODE_NATIVE_FAKE_FAULT)
        ? process.env.ZCODE_NATIVE_FAKE_FAULT
        : undefined;
    if (fault === "inherited-path")
      await writeFile(join(cwd, "node"), "#!/bin/sh\ntouch unapproved-shell-effect.txt\n", { mode: 0o755 });
    if (fake)
      upstream = await startPrivateFake({
        cwd,
        readPath,
        writePath,
        writeContent,
        bashCommand,
        changedContent: () => changedContent,
        fault,
      });
    const childEnv = {
      PATH: [dirname(trustedNode), process.env.PATH ?? ""].join(delimiter),
      HOME: fake ? disposable : process.env.HOME,
      TMPDIR: disposable,
      NODE_ENV: "production",
    };
    if (fake) childEnv.ZCODE_NATIVE_FAKE_URL = upstream.baseUrl;
    if (fault === "webfetch-exposed") childEnv.ZCODE_NATIVE_FAKE_EXPOSE_WEBFETCH = "1";
    if (fault === "hang-scan") childEnv.ZCODE_NATIVE_FAKE_HANG_SCAN = "1";
    if (["shell-profile", "shell-override", "inherited-path"].includes(fault))
      childEnv.ZCODE_NATIVE_FAKE_EXEC_FAULT = fault;
    if (
      [
        "wrong-model-body",
        "missing-tokens",
        "oversized-tokens",
        "wrong-query",
        "wrong-method",
        "wrong-route",
      ].includes(fault)
    )
      childEnv.ZCODE_NATIVE_FAKE_TRANSPORT_FAULT = fault;
    channel = openPrivateChannel(
      process.execPath,
      [
        "--import",
        join(rootDir, "node_modules/tsx/dist/loader.mjs"),
        join(rootDir, "apps/zcode-cli/packages/bootstrap/src/native-private-child.ts"),
        fake ? "fixture/fixture-model" : route,
      ],
      { cwd: disposable, env: childEnv, stdio: ["pipe", "pipe", "pipe", "ipc"] },
      (message) => {
        if (message?.kind === "native-turn") {
          if (fault === "foreign-native-command")
            message.sourceCommandId = `foreign-${randomUUID()}`;
          if (fault === "foreign-native-session") message.sessionId = `foreign-${randomUUID()}`;
          if (fault === "foreign-native-turn") message.runtimeTurnId = `foreign-${randomUUID()}`;
          const active = report.turns.at(-1);
          if (
            message.sessionId !== sessionId ||
            !active ||
            message.sourceCommandId !== active.commandId ||
            typeof message.runtimeTurnId !== "string" ||
            !message.runtimeTurnId ||
            typeof message.productMessageId !== "string" ||
            !message.productMessageId ||
            (active.runtimeTurnId && active.runtimeTurnId !== message.runtimeTurnId)
          )
            throw new Error("native turn/command mapping invalid");
          active.runtimeTurnId = message.runtimeTurnId;
          active.productMessageId = message.productMessageId;
        } else if (message?.kind === "native-permission") {
          const active = report.turns.at(-1);
          if (
            !active?.runtimeTurnId ||
            message.sessionId !== sessionId ||
            message.runtimeTurnId !== active.runtimeTurnId ||
            typeof message.requestId !== "string" ||
            !message.requestId ||
            typeof message.toolCallId !== "string" ||
            !message.toolCallId ||
            typeof message.toolName !== "string" ||
            !/^[a-f0-9]{64}$/u.test(message.inputDigest) ||
            Object.keys(message).some((key) => ![
              "kind", "sessionId", "runtimeTurnId", "requestId", "toolCallId", "toolName", "inputDigest",
            ].includes(key)) ||
            seenNativeRequestIds.has(message.requestId) ||
            seenNativeRequestIds.size >= 12
          )
            throw new Error("native permission identity invalid");
          seenNativeRequestIds.add(message.requestId);
          nativePermissions.set(message.requestId, {
            sessionId: message.sessionId, runtimeTurnId: message.runtimeTurnId,
            requestId: message.requestId, toolCallId: message.toolCallId,
            toolName: message.toolName, inputDigest: message.inputDigest,
            commandId: active.commandId,
          });
          permissionWake?.();
        } else if (message?.kind === "model-observation") {
          usage.observe(message);
          if (
            message.purpose === "session_title_generation" &&
            message.phase !== "start" &&
            phase >= 2
          )
            report.auxiliaryCompletedAfterNewTurn = true;
        } else if (message?.kind === "provider-usage") {
          usage.provider(message);
        } else if (message?.kind === "private-phase-ready" && message.phase === phaseReady?.phase) {
          phaseReady.resolve();
          phaseReady = undefined;
        } else if (["model", "http", "dispatch"].includes(message?.kind)) {
          const type = message.kind;
          if (
            !Number.isSafeInteger(message.count) ||
            message.count !== ++counts[type] ||
            message.count > 12
          )
            throw new Error("IPC counter invalid");
          if (type !== "model") usage.http(message);
          if (type === "model") {
            if (!["stream", "generate"].includes(message.operation))
              throw new Error("Model operation invalid");
            report.modelCalls[message.operation]++;
          } else if (type === "http") report.httpAttempts++;
          else report.httpDispatches++;
        } else if (message?.kind === "exit" || message?.kind === "failure") {
          if (
            finalCounts ||
            message.attempts !== counts.http ||
            message.dispatches !== counts.dispatch ||
            message.modelCalls !== counts.model ||
            message.dispatches > message.attempts ||
            message.attempts > 12 ||
            message.modelCalls > 12
          )
            throw new Error("IPC final mismatch");
          finalCounts = message;
          report.privateArtifactScan =
            message.scanCompleted === true &&
            Number.isInteger(message.scanFiles) &&
            message.scanFiles > 0;
          report.scannedFiles = report.privateArtifactScan ? message.scanFiles : 0;
          if (
            !Number.isSafeInteger(message.forbiddenToolRequests) ||
            message.forbiddenToolRequests < 0
          )
            throw new Error("tool counter invalid");
          report.forbiddenToolRequests = message.forbiddenToolRequests;
          if (message.kind === "failure") {
            failure = true;
            report.failureStage = ["configuration", "bootstrap", "runtime"].includes(message.stage)
              ? message.stage
              : "child";
          }
        }
      },
    );
    softTimer = setTimeout(
      () => {
        failure = true;
        channel.abort();
      },
      Math.max(
        1,
        fake
          ? Math.min(30_000, deadlineAt - Date.now() - 12_000)
          : deadlineAt - Date.now() - 12_000,
      ),
    );
    const rowList = () => [...rows.values()];
    async function next(predicate) {
      for (;;) {
        if (failure || Date.now() >= deadlineAt - 9_000)
          throw new Error("private deadline/failure");
        const frame = await channel.next();
        for (const row of nativeEvidenceRows(frame, sessionId)) {
          const ordinal = ++evidenceOrdinal;
          if (
            fault === "unsolicited-outcome" &&
            row.kind === "toolCall" &&
            row.status === "success" &&
            phase === 1
          )
            row.toolName = "Write";
          if (
            fault === "old-row" &&
            row.kind === "toolCall" &&
            row.status === "success" &&
            phase === 2
          )
            row.turnId = report.turns[0]?.turnId ?? row.turnId;
          if (!row.rowId) throw new Error("private row identity missing");
          // 故障注入：延迟 V4 tool 投影，使同一真实子进程的 permission 在无产品行时校验。
          if (
            !["fresh-foreign-call-before-row", "fresh-foreign-request-before-row"].includes(
              fault,
            ) ||
            row.kind !== "toolCall"
          )
            rows.set(row.rowId, row);
          if (rows.size > 2048) throw new Error("private row budget exceeded");
          const current = report.turns.at(-1);
          if (phase === 3 && current && row.turnId === turnId) {
            if (
              row.kind === "toolCall" &&
              row.toolName === "Read" &&
              row.status === "success" &&
              row.output?.text?.includes(changedContent)
            )
              current.freshReadEvidenceSeq = ordinal;
            if (
              row.kind === "assistantText" &&
              row.state === "complete" &&
              row.text?.includes(changedContent)
            )
              current.finalAnswerEvidenceSeq = ordinal;
          }
          if (row.kind === "turnHeader" && row.sourceCommandId === current?.commandId) {
            turnId = row.turnId;
            current.turnId = turnId;
            if (row.state === "running" && !current.events.includes("start"))
              current.events.push("start");
            if (row.state === "completedSuccess" && !current.events.includes("terminal"))
              current.events.push("terminal");
            if (["failed", "completedInterrupted"].includes(row.state))
              throw new Error("private turn failed");
          }
          if (row.kind === "toolCall" && row.status === "success") {
            if (
              row.turnId !== turnId ||
              !current ||
              !["Read", "Write", "Bash"].includes(row.toolName) ||
              (row.toolName !== "Read" &&
                !current.actions.some(
                  (action) =>
                    action.toolCallId === row.toolCallId &&
                    action.toolName === row.toolName &&
                    action.decision === "allow",
                ))
            )
              throw new Error("unexpected successful tool row");
            if (!current.observedToolNames.includes(row.toolName))
              current.observedToolNames.push(row.toolName);
          }
        }
        if (frame.method === "interaction/requestPermission" && frame.id !== undefined) {
          if (pendingIdentity) {
            channel.send({ id: frame.id, result: { decision: "deny" } });
            throw new Error("concurrent permission identity unresolved");
          }
          const params = frame.params;
          if (fault === "stale-session") params.sessionId = "stale";
          if (fault === "stale-call") params.toolCallId = "stale";
          if (fault === "stale-turn" && phase === 2) params.turnId = report.turns[0]?.nativeTurnId;
          if (fault === "fresh-foreign-turn") params.turnId = `foreign-${randomUUID()}`;
          // 模拟 RPC 帧被替换为新鲜外来业务 ID；不依赖已有 V4 工具行阻止副作用。
          if (fault === "fresh-foreign-call-before-row")
            params.toolCallId = `foreign-${randomUUID()}`;
          if (fault === "fresh-foreign-request-before-row")
            params.requestId = `foreign-${randomUUID()}`;
          const current = report.turns.at(-1);
          // 修复：原生 turn.started 先于 Model/tool 执行产生，订阅事实给出运行时 turnId、
          // 已准入 sourceCommandId 与持久 messageId；不把 V4 product turnId 当作 runtime UUID。
          // 反向 RPC 可能先于订阅帧：只等待权威事件，不凭超时放行。
          if (!current?.runtimeTurnId) {
            pendingIdentity = true;
            try {
              await next(() => !!current?.runtimeTurnId);
            } finally {
              pendingIdentity = false;
            }
          }
          // 修复：V4 行可能晚于反向 RPC。只用原生 executor 在 broker 前发出的
          // permission.requested 事实证明业务 request/call/input，不能凭新鲜字符串放行。
          if (!nativePermissions.has(params?.requestId)) {
            pendingIdentity = true;
            let identityTimer;
            try {
              await Promise.race([
                new Promise((resolve) => {
                  permissionWake = resolve;
                }),
                new Promise((_, reject) => {
                  identityTimer = setTimeout(
                    () => reject(new Error("native permission fact unavailable")),
                    Math.max(1, Math.min(1000, deadlineAt - Date.now() - 9000)),
                  );
                }),
              ]);
            } finally {
              clearTimeout(identityTimer);
              pendingIdentity = false;
              permissionWake = undefined;
            }
          }
          const nativePermission = nativePermissions.get(params?.requestId);
          if (
            ["fresh-foreign-call-before-row", "fresh-foreign-request-before-row"].includes(fault) &&
            rowList().some(
              (row) => row.kind === "toolCall" && row.toolCallId === nativePermission?.toolCallId,
            )
          )
            throw new Error("fault did not exercise permission before V4 row");
          const existingRows = rowList().filter(
            (row) => row.kind === "toolCall" && row.toolCallId === params?.toolCallId,
          );
          const matchingRow = existingRows.find(
            (row) => row.turnId === turnId && row.toolName === params?.toolName,
          );
          const exact =
            !!current &&
            current.events.includes("ack") &&
            params?.sessionId === sessionId &&
            params?.turnId === current.runtimeTurnId &&
            nativePermission?.commandId === current.commandId &&
            nativePermission?.sessionId === params.sessionId &&
            nativePermission?.runtimeTurnId === params.turnId &&
            nativePermission?.toolCallId === params.toolCallId &&
            nativePermission?.toolName === params.toolName &&
            nativePermission?.inputDigest ===
              createHash("sha256").update(JSON.stringify(params.input)).digest("hex") &&
            typeof params?.toolCallId === "string" &&
            params.toolCallId.length > 0 &&
            (existingRows.length === 0 || !!matchingRow) &&
            !report.turns.some((turn) =>
              turn.actions.some((action) => action.toolCallId === params.toolCallId),
            ) &&
            isExactFixtureAction({
              toolName: params.toolName,
              params: params.input,
              cwd,
              readPath,
              writePath,
              writeContent,
              bashCommand,
              phase,
              deniedWrites,
            });
          if (!exact) {
            channel.send({ id: frame.id, result: { decision: "deny" } });
            throw new Error("permission identity/action denied");
          }
          const decision = permittedFixtureAction({
            toolName: params.toolName,
            params: params.input,
            cwd,
            readPath,
            writePath,
            writeContent,
            bashCommand,
            phase,
            deniedWrites,
          });
          if (params.toolName === "Write" && phase === 1) {
            if (deniedWrites++) throw new Error("duplicate denied write");
            await assertAbsent(writePath);
          }
          if (params.toolName === "Write" && phase === 2) await assertAbsent(writePath);
          if (current.nativeTurnId && current.nativeTurnId !== params.turnId)
            throw new Error("permission runtime turn changed");
          if (report.turns.slice(0, -1).some((previous) => previous.nativeTurnId === params.turnId))
            throw new Error("stale native permission turn");
          current.nativeTurnId = params.turnId;
          nativePermissions.delete(params.requestId);
          current.actions.push({
            toolName: params.toolName,
            toolCallId: params.toolCallId,
            decision,
            matchedExactInput: true,
          });
          channel.send({ id: frame.id, result: { decision } });
          continue;
        }
        if (frame.method === "session/requestRuntimePreferences" && frame.id !== undefined) {
          channel.send({
            id: frame.id,
            result: {
              askUserQuestionAutoResolutionEnabled: true,
              nativeSearchEnhancementsEnabled: false,
              memoryEnabled: false,
            },
          });
          continue;
        }
        if (predicate(frame)) return frame;
      }
    }
    async function command(type, sid, payload) {
      const id = ++sequence;
      const commandId = `private-${id}`;
      channel.send({
        id,
        method: "v4/command",
        params: {
          commandId,
          clientId: "private",
          sessionId: sid,
          type,
          payload,
          issuedAt: Date.now(),
        },
      });
      return { reply: await next((frame) => frame.id === id), commandId };
    }
    await next(
      (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
    );
    const { reply: created } = await command("createSession", null, {
      workspaceId: cwd,
      toolAllowlist:
        fault === "webfetch-exposed"
          ? ["Read", "Write", "Bash", "WebFetch"]
          : ["Read", "Write", "Bash"],
      mcpServers: [],
    });
    if (created.result?.status !== "accepted") throw new Error("session rejected");
    sessionId = created.result.result.sessionId;
    report.session = createHash("sha256")
      .update(randomUUID() + sessionId)
      .digest("hex")
      .slice(0, 12);
    channel.send({
      id: ++sequence,
      method: "v4/conversation/subscribe",
      params: {
        topic: `conversation/${sessionId}`,
        connectionId: "private",
        clientMode: "desktop-continuous",
      },
    });
    await next((frame) => frame.id === sequence && !!frame.result?.ack?.subscriptionId);
    channel.send({
      id: ++sequence,
      method: "session/subscribe",
      params: { sessionId, deliveryKind: "desktop-continuous", includeSnapshot: false },
    });
    await next((frame) => frame.id === sequence && frame.result?.sessionId === sessionId);
    for (phase = 1; phase <= 3; phase++) {
      let phaseTimer;
      try {
        const ready = new Promise((resolve, reject) => {
          phaseTimer = setTimeout(() => reject(new Error("phase fence missing")), 3000);
          phaseReady = { phase, resolve };
          channel.child.send({ kind: "private-phase", phase }, (err) => {
            if (err) reject(new Error("IPC phase failed"));
          });
        });
        await Promise.race([
          ready,
          channel.exited.then(() => {
            throw new Error("child exited during phase");
          }),
        ]);
      } finally {
        clearTimeout(phaseTimer);
        phaseReady = undefined;
      }
      const expected =
        phase === 1
          ? `fixture instruction 1: Use Read ${readPath}; attempt Write ${writePath} content ${writeContent} once. If denied stop tools and answer.`
          : phase === 2
            ? `fixture instruction 2: NEW permission to Write ${writePath} content ${writeContent}, then Bash exactly ${bashCommand} in workspace cwd; answer after both.`
            : `fixture instruction 3: Use Read ${readPath}, then answer with its exact newly observed content.`;
      const current = {
        commandId: `private-${sequence + 1}`,
        events: [],
        actions: [],
        observedToolNames: [],
        usage: null,
      };
      report.turns.push(current);
      turnId = undefined;
      const { reply, commandId } = await command("sendText", sessionId, { text: expected });
      if (reply.result?.status !== "accepted") throw new Error("send rejected");
      report.ack++;
      if (phase === 2 && fault === "aux-interleave") upstream.releaseAux();
      current.events.push("ack"); // ACK can follow start; no invented ACK-before-start ordering.
      const terminal =
        matchingTerminal(rowList(), commandId) ??
        (await next(() => !!matchingTerminal(rowList(), commandId)),
        matchingTerminal(rowList(), commandId));
      if (
        !terminal ||
        !current.events.includes("start") ||
        !current.events.includes("terminal") ||
        !current.runtimeTurnId ||
        (current.nativeTurnId && current.nativeTurnId !== current.runtimeTurnId) ||
        current.productMessageId !== terminal
      )
        throw new Error("matching native/product execution mapping missing");
      report.matchingTerminals++;
      const scoped = rowList();
      const tool = (name, input, predicate) =>
        matchingTool(scoped, terminal, name, input, predicate);
      for (const action of current.actions) {
        if (
          !scoped.some(
            (row) =>
              row.kind === "toolCall" &&
              row.turnId === terminal &&
              row.toolCallId === action.toolCallId &&
              row.toolName === action.toolName &&
              (action.decision === "deny" ? row.status !== "success" : row.status === "success"),
          )
        )
          throw new Error("permission outcome not bound to matching tool row");
      }
      if (phase === 1) {
        await assertAbsent(writePath); // after terminal, not only before denying
        report.effects.deniedWrite =
          deniedWrites === 1 &&
          current.actions.some(
            (action) => action.toolName === "Write" && action.decision === "deny",
          ) &&
          tool(
            "Read",
            { file_path: readPath },
            (output) => typeof output?.text === "string" && output.text.includes("seed=violet"),
          );
        if (!report.effects.deniedWrite) throw new Error("deny/read proof missing");
      } else if (phase === 2) {
        report.effects.allowedWrite =
          current.actions.some(
            (action) => action.toolName === "Write" && action.decision === "allow",
          ) &&
          tool("Write", { file_path: writePath, content: writeContent }) &&
          (await readFile(writePath, "utf8")) === writeContent;
        report.effects.bash =
          current.actions.some(
            (action) => action.toolName === "Bash" && action.decision === "allow",
          ) &&
          tool(
            "Bash",
            { command: bashCommand },
            (output) => typeof output?.text === "string" && output.text.includes("exit=0"),
          ) &&
          (await readFile(bashPath, "utf8")) === `bash-verified|${trustedNode}`;
        if (!report.effects.allowedWrite || !report.effects.bash)
          throw new Error("write/bash proof missing");
        changedContent = `fresh-${randomUUID()}`; // not inferable from previous prompts/results
        await writeFile(readPath, changedContent);
      } else {
        report.effects.freshReadAnswer =
          tool(
            "Read",
            { file_path: readPath },
            (output) => typeof output?.text === "string" && output.text.includes(changedContent),
          ) &&
          matchingFinalAnswer(scoped, terminal, changedContent) &&
          Number.isSafeInteger(current.freshReadEvidenceSeq) &&
          current.finalAnswerEvidenceSeq > current.freshReadEvidenceSeq;
        if (!report.effects.freshReadAnswer) throw new Error("fresh Read/answer proof missing");
      }
    }
    if (
      report.ack !== 3 ||
      report.httpAttempts > 12 ||
      report.httpDispatches !== report.httpAttempts
    )
      throw new Error("counter/proof incomplete");
    report.scenarioVerified = true;
  } catch {
    failure = true;
    report.failureStage ??= "scenario";
  } finally {
    clearTimeout(softTimer);
    if (channel) {
      const exit = await channel.reap(deadlineAt - 5_000);
      report.childExit = exit?.code ?? null;
      if (
        !exit ||
        exit.signal ||
        (channel.error &&
          channel.error.message !== "private child exited" &&
          channel.error.message !== "private child closed")
      )
        failure = true;
      report.childOutputBytes = channel.outputBytes;
    }
    if (
      [
        "fresh-foreign-call-before-row",
        "fresh-foreign-request-before-row",
        "fresh-foreign-turn",
        "foreign-native-command",
        "foreign-native-session",
        "foreign-native-turn",
        "stale-session",
        "stale-call",
        "stale-turn",
      ].includes(fault)
    ) {
      try {
        await assertAbsent(writePath);
        await assertAbsent(bashPath);
        report.beforeEffectFileAbsent = true;
      } catch {
        report.beforeEffectFileAbsent = false;
        failure = true;
      }
    }
    if (["shell-profile", "shell-override", "inherited-path"].includes(fault)) {
      try {
        await assertAbsent(join(cwd, "unapproved-shell-effect.txt"));
        report.unapprovedSubprocessAbsent = true;
      } catch {
        report.unapprovedSubprocessAbsent = false;
        failure = true;
      }
    }
    if (upstream) {
      if (
        upstream.counts.requests !== report.httpDispatches ||
        upstream.counts.forbiddenRequests !== 0 ||
        upstream.counts.forbiddenRegisteredTools !== 0
      )
        failure = true;
      try {
        await upstream.close();
      } catch {
        failure = true;
      }
      report.fakeUpstreamRequests = upstream.counts.requests;
      report.fakeForbiddenRequests = upstream.counts.forbiddenRequests;
      report.fakeForbiddenRegisteredTools = upstream.counts.forbiddenRegisteredTools;
    }
    if (fault === "hang-cleanup") {
      await removeBounded(disposable, Date.now() + 1500, { rootDir, hang: true });
      failure = true; // synthetic timeout is a failed gate, not a successful cleanup proof
    }
    report.cleanup = await removeBounded(
      disposable,
      fake ? Math.min(deadlineAt, Date.now() + 8000) : deadlineAt,
      { rootDir },
    );
    const observedUsage = usage.results(report.turns, sessionId);
    report.modelUsageCalls = observedUsage.list;
    report.usage = observedUsage.usage;
    report.usageCoverage = observedUsage.usageCoverage;
    report.httpCountAttribution = observedUsage.httpCountAttribution;
    report.modelCountAttribution = observedUsage.list.every((call) => call.commandId !== null)
      ? "native-command"
      : "partial";
    report.usageQualified =
      observedUsage.usageCoverage.main === "reported" &&
      observedUsage.usageCoverage.auxiliary === "reported";
    if (
      usage.count !== counts.model ||
      usage.dispatchCount !== counts.dispatch ||
      usage.reservationCount !== counts.http
    )
      failure = true;
    report.scenarioVerified =
      report.scenarioVerified &&
      !failure &&
      !!finalCounts &&
      finalCounts.kind === "exit" &&
      report.childExit === 0 &&
      report.privateArtifactScan &&
      report.forbiddenToolRequests === 0 &&
      report.cleanup &&
      Date.now() <= deadlineAt;
    // Runtime UUIDs are only needed in-memory for stale-turn fencing, not retained proof.
    for (const turn of report.turns) {
      delete turn.nativeTurnId;
      delete turn.turnId;
      delete turn.runtimeTurnId;
      delete turn.productMessageId;
      delete turn.freshReadEvidenceSeq;
      delete turn.finalAnswerEvidenceSeq;
      for (const action of turn.actions) delete action.toolCallId;
    }
    console.log(JSON.stringify(report));
    if (!report.scenarioVerified) process.exitCode = 1;
  }
}
