#!/usr/bin/env node
// 默认只执行 fake；真实路由须显式 opt-in。没有任何隐式付费测试调用。
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanDisposable, assertAbsent } from "./native-private-artifacts.mjs";
import { runPrivateFake } from "./native-private-fake.mjs";
import {
  matchingFinalAnswer,
  matchingTerminal,
  nativeEvidenceRows,
  permittedFixtureAction,
  isExactFixtureAction,
} from "../apps/zcode-cli/packages/bootstrap/src/native-private-evidence.ts";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allowed = new Set(["stepfun/step-3.5-flash", "axonhub/deepseek-v4-flash"]);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(
    "Usage: node --import tsx scripts/native-private-runner.mjs [--fake | --live stepfun/step-3.5-flash | --live axonhub/deepseek-v4-flash]",
  );
} else if (args.length === 0 || (args.length === 1 && args[0] === "--fake")) {
  await runPrivateFake(rootDir);
} else if (args.length === 2 && args[0] === "--live" && allowed.has(args[1])) {
  await live(args[1]);
} else {
  console.error("invalid route/mode; use --help");
  process.exitCode = 2;
}

async function live(route) {
  const routeDeadlineAt = Date.now() + 240_000;
  const disposable = await mkdtemp(join(tmpdir(), "native-private-"));
  const cwd = join(disposable, "worktree");
  const sessionMarker = randomUUID();
  const readPath = join(cwd, "input.txt");
  const writePath = join(cwd, "output.txt");
  const bashPath = join(cwd, "bash-effect.txt");
  const writeContent = `approved-${sessionMarker}`;
  const changedContent = `fresh-${sessionMarker}`;
  const bashCommand = "node verify.cjs";
  const report = {
    mode: "live",
    route,
    session: "scoped",
    turns: [],
    ack: 0,
    matchingTerminals: 0,
    modelCalls: { stream: 0, generate: 0 },
    httpAttempts: 0,
    usage: "absent",
    childExit: null,
    effects: { deniedWrite: false, allowedWrite: false, bash: false, freshReadAnswer: false },
    cleanup: false,
    scenarioVerified: false,
    realCredentialArtifactScan: "not-performed",
    failureStage: null,
  };
  let child;
  let killTimer;
  let deadline;
  let failure = false;
  let privateOutputBytes = 0;
  try {
    await mkdir(cwd);
    await writeFile(readPath, "seed=violet\n");
    await writeFile(join(cwd, "approved-content.txt"), writeContent);
    await writeFile(
      join(cwd, "verify.cjs"),
      "require('node:fs').writeFileSync('bash-effect.txt', 'bash-verified'); console.log('exit=0')\n",
    );
    // 子进程读取原 HOME 中现有私有配置后立即切到 cwd=一次性隔离 root；key 不跨 IPC/argv/env。
    child = spawn(
      process.execPath,
      [
        "--import",
        join(rootDir, "node_modules/tsx/dist/loader.mjs"),
        join(rootDir, "apps/zcode-cli/packages/bootstrap/src/native-private-child.ts"),
        route,
      ],
      {
        cwd: disposable,
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    child.stderr.on("data", (chunk) => {
      privateOutputBytes += chunk.length;
    }); // never print raw stderr
    let pendingPhase;
    child.on("message", (message) => {
      if (message?.kind === "private-phase-ready" && message.phase === pendingPhase?.phase) {
        pendingPhase.resolve();
        pendingPhase = undefined;
      }
      if (
        message?.kind === "model" &&
        (message.operation === "stream" || message.operation === "generate")
      )
        report.modelCalls[message.operation]++;
      if (message?.kind === "http") report.httpAttempts++;
      if (message?.kind === "failure") {
        failure = true;
        report.failureStage = ["configuration", "bootstrap", "runtime"].includes(message.stage)
          ? message.stage
          : "child";
      }
    });
    deadline = setTimeout(
      () => {
        failure = true;
        child.kill();
      },
      Math.max(1, Math.min(230_000, routeDeadlineAt - Date.now() - 10_000)),
    );
    const pending = [];
    let wake;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 1_048_576 || pending.length >= 128)
          throw new Error("private frame budget exceeded");
        pending.push(JSON.parse(line));
      } catch {
        failure = true;
        child.kill();
      }
      wake?.();
      wake = undefined;
    });
    lines.on("close", () => {
      wake?.();
      wake = undefined;
    });
    let sequence = 0;
    let sessionId = "";
    let phase = 0;
    let deniedWrites = 0;
    let observedCumulative = 0;
    const rows = [];
    const next = async (predicate) => {
      for (;;) {
        if (failure) throw new Error("private child failed");
        const frame = pending.shift();
        if (!frame) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error("private child exited");
          await new Promise((done) => {
            wake = done;
          });
          continue;
        }
        const incomingRows = nativeEvidenceRows(frame, sessionId);
        rows.push(...incomingRows);
        if (rows.length > 2048) throw new Error("private row budget exceeded");
        const current = report.turns.at(-1);
        for (const row of incomingRows) {
          if (row.kind === "toolCall" && row.status === "success" && current) {
            if (!["Read", "Write", "Bash"].includes(row.toolName))
              throw new Error("unexpected tool execution");
            if (!current.observedToolNames.includes(row.toolName))
              current.observedToolNames.push(row.toolName);
          }
          if (row.kind !== "turnHeader" || row.sourceCommandId !== current?.commandId) continue;
          if (row.state === "running" && !current.events.includes("start"))
            current.events.push("start");
          if (row.state === "completedSuccess" && !current.events.includes("terminal"))
            current.events.push("terminal");
        }
        const payload =
          frame.method === "v4/conversation/frame" ? frame.params?.frame?.payload : undefined;
        const usage =
          payload?.kind === "snapshot"
            ? payload.snapshot?.usage
            : payload?.deltas?.find((delta) => delta.op === "state.updated" && delta.patch?.usage)
                ?.patch?.usage;
        // 累计零可能仅是初始态；只有本次真实上升才认定该轮 usage 在场。
        if (usage?.cumulative) {
          const total = Object.values(usage.cumulative).reduce(
            (sum, value) => sum + (typeof value === "number" && value > 0 ? value : 0),
            0,
          );
          if (total > observedCumulative) {
            report.usage = "present";
            if (current) current.usage = "present";
            observedCumulative = total;
          }
        }
        if (frame.method === "interaction/requestPermission" && frame.id !== undefined) {
          const toolName = frame.params?.toolName;
          const permission = {
            toolName,
            params: frame.params?.input,
            cwd,
            readPath,
            writePath,
            writeContent,
            bashCommand,
            phase,
            deniedWrites,
          };
          const exact = isExactFixtureAction(permission);
          const decision = permittedFixtureAction(permission);
          if (!exact) {
            child.stdin.write(
              JSON.stringify({ id: frame.id, result: { decision: "deny" } }) + "\n",
            );
            throw new Error("unapproved tool action");
          }
          if (toolName === "Write" && decision === "allow") await assertAbsent(writePath);
          if (toolName === "Write" && decision === "deny" && deniedWrites === 0) {
            await assertAbsent(writePath);
            deniedWrites++;
            report.effects.deniedWrite = true;
          }
          if (decision === "deny" && !(toolName === "Write" && deniedWrites === 1)) {
            child.stdin.write(
              JSON.stringify({ id: frame.id, result: { decision: "deny" } }) + "\n",
            );
            throw new Error("unapproved tool action");
          }
          current?.actions.push({ toolName, decision, matchedExactInput: exact });
          child.stdin.write(JSON.stringify({ id: frame.id, result: { decision } }) + "\n");
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
    const command = async (type, sid, payload) => {
      const id = ++sequence;
      const commandId = `private-${id}`;
      child.stdin.write(
        JSON.stringify({
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
        }) + "\n",
      );
      return { reply: await next((frame) => frame.id === id), commandId };
    };
    await next(
      (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
    );
    const { reply: created } = await command("createSession", null, { workspaceId: cwd });
    if (created.result?.status !== "accepted") throw new Error("session rejected");
    sessionId = created.result.result.sessionId;
    report.session = createHash("sha256")
      .update(sessionMarker + sessionId)
      .digest("hex")
      .slice(0, 12);
    child.stdin.write(
      JSON.stringify({
        id: ++sequence,
        method: "v4/conversation/subscribe",
        params: {
          topic: `conversation/${sessionId}`,
          connectionId: "private",
          clientMode: "desktop-continuous",
        },
      }) + "\n",
    );
    await next((frame) => frame.id === sequence && !!frame.result?.ack?.subscriptionId);
    for (phase = 1; phase <= 3; phase++) {
      // IPC ACK establishes the fixture's I/O phase before submitting the next V4 command.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPhase = undefined;
          reject(new Error("private phase fence missing"));
        }, 3000);
        pendingPhase = {
          phase,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        };
        child.send({ kind: "private-phase", phase });
      });
      const expected =
        phase === 1
          ? `Use Read ${readPath}; attempt Write ${writePath} with exact content ${writeContent} twice (first denied, second allowed); then Bash command exactly ${bashCommand} from workspace cwd. Answer only after tool results.`
          : phase === 2
            ? "Answer this turn without side effects."
            : `Use Read ${readPath}; then answer with its exact newly observed content.`;
      const turnFact = {
        commandId: `private-${sequence + 1}`,
        events: [],
        actions: [],
        observedToolNames: [],
        usage: "absent",
      };
      report.turns.push(turnFact);
      const { reply, commandId } = await command("sendText", sessionId, { text: expected });
      if (reply.result?.status !== "accepted") throw new Error("send rejected");
      report.ack++;
      turnFact.events.push("ack");
      // 修复：不以 ACK、旧 control phase 或旧命令 row 来触发下一轮/外部文件变更。
      const terminal =
        matchingTerminal(rows, commandId) ??
        (await next(() => !!matchingTerminal(rows, commandId)).then(() =>
          matchingTerminal(rows, commandId),
        ));
      if (!terminal) throw new Error("matching terminal missing");
      report.matchingTerminals++;
      if (!turnFact.events.includes("start") || !turnFact.events.includes("terminal"))
        throw new Error("missing start/terminal row");
      if (phase === 1) {
        report.effects.allowedWrite = (await readFile(writePath, "utf8")) === writeContent;
        report.effects.bash = (await readFile(bashPath, "utf8")) === "bash-verified";
        if (!report.effects.deniedWrite || !report.effects.allowedWrite || !report.effects.bash)
          throw new Error("effect mismatch");
      }
      if (phase === 2) await writeFile(readPath, changedContent);
      if (phase === 3)
        report.effects.freshReadAnswer = matchingFinalAnswer(rows, terminal, changedContent);
    }
    if (!report.effects.freshReadAnswer || report.httpAttempts > 12 || report.ack !== 3)
      throw new Error("proof incomplete");
    report.scenarioVerified = true;
  } catch {
    failure = true;
    report.failureStage ??= "scenario";
  } finally {
    child?.stdin.end();
    if (child) {
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      report.childExit = await new Promise((done) =>
        child.exitCode !== null ? done(child.exitCode) : child.once("exit", done),
      );
      clearTimeout(killTimer);
    }
    if (deadline) clearTimeout(deadline);
    // 只能用安全常量扫描，不能把真实私有 key/endpoint 放进 retained report 或 stdout。
    // 合成提示内容可存在一次性 DB，但只在隔离目录，扫描后必删。
    try {
      await scanDisposable(disposable, [
        "fixture-private-key-sentinel",
        "fixture-private-endpoint-sentinel",
      ]);
    } catch {
      failure = true;
    }
    try {
      await rm(disposable, { recursive: true, force: true });
      report.cleanup = true;
    } catch {
      failure = true;
    }
    report.childStderrBytes = privateOutputBytes;
    report.scenarioVerified =
      report.scenarioVerified &&
      !failure &&
      report.childExit === 0 &&
      Date.now() <= routeDeadlineAt;
    console.log(JSON.stringify(report));
    if (!report.scenarioVerified) process.exitCode = 1;
  }
}
