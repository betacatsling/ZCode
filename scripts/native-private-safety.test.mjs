import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { removeBounded } from "./native-private-cleanup.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openPrivateChannel } from "./native-private-channel.mjs";
import { createPrivateUsage } from "./native-private-usage.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));

async function fake(fault, implicit = false) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/native-private-runner.mjs", ...(implicit ? [] : ["--fake"])],
    {
      cwd: root,
      env: { ...process.env, ...(fault ? { ZCODE_NATIVE_FAKE_FAULT: fault } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    assert.ok(stdout.length < 65536);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    assert.ok(stderr.length < 8192);
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(stderr.includes("fixture-private-key-sentinel"), false);
  const report = JSON.parse(stdout.trim());
  assert.equal(stdout.includes("fixture-private-key-sentinel"), false);
  assert.equal(
    /http:\/\/127\.0\.0\.1:\d+\/fixture/u.test(stdout),
    false,
    "selected randomized endpoint must stay private",
  );
  assert.equal(report.cleanup, true);
  assert.equal(
    report.privateArtifactScan,
    !["hang-scan", "endpoint-leak", "foreign-native-command", "foreign-native-session"].includes(
      fault,
    ),
  );
  if (!["hang-scan", "endpoint-leak"].includes(fault)) assert.equal(report.childExit, 0);
  if (!["foreign-native-command", "foreign-native-session"].includes(fault))
    assert.equal(report.httpDispatches, report.fakeUpstreamRequests);
  assert.equal(report.fakeForbiddenRequests, 0);
  assert.equal(
    report.fakeForbiddenRegisteredTools,
    0,
    "effective native Model tool registry must be fixture-only",
  );
  return { code, report };
}

test(
  "default mode uses same child/controller; wrong route and help never select live",
  { timeout: 60000 },
  async () => {
    const { code, report } = await fake(undefined, true);
    assert.equal(code, 0);
    assert.equal(report.mode, "fake");
    assert.equal(report.scenarioVerified, true);
    for (const args of [["--help"], ["--live", "unapproved/model"], ["--live"]]) {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "scripts/native-private-runner.mjs", ...args],
        {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          env: { PATH: process.env.PATH, HOME: join(root, "missing-profile") },
        },
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.resume();
      const status = await new Promise((resolve) => child.on("exit", resolve));
      assert.equal(status, args[0] === "--help" ? 0 : 2);
      assert.equal(out.includes("privateArtifactScan"), false);
    }
  },
);

test(
  "same fake/live V4 orchestrator completes three isolated turns and private scan",
  { timeout: 60000 },
  async () => {
    const { code, report } = await fake();
    assert.equal(code, 0);
    assert.equal(report.scenarioVerified, true);
    assert.equal(report.matchingTerminals, 3);
    assert.deepEqual(Object.values(report.effects), [true, true, true, true]);
    assert.ok(report.httpAttempts <= 12 && report.modelCalls.stream > 0);
    assert.equal(
      report.modelUsageCalls.length,
      report.modelCalls.stream + report.modelCalls.generate,
    );
    assert.ok(
      report.modelUsageCalls.some(
        (call) =>
          call.purpose === "agent_step" &&
          call.metrics.inputTokens.status === "reported" &&
          call.metrics.inputTokens.value === 4,
      ),
    );
    assert.ok(
      report.modelUsageCalls.every(
        (call) =>
          call.commandId === null || report.turns.some((turn) => turn.commandId === call.commandId),
      ),
    );
    assert.equal(report.usageCoverage.main, "reported");
    assert.equal(report.httpCountAttribution, "model-call");
    assert.equal(
      report.modelUsageCalls.reduce((total, call) => total + call.httpReservations, 0),
      report.httpAttempts,
    );
    assert.equal(
      report.modelUsageCalls.reduce((total, call) => total + call.httpDispatches, 0),
      report.fakeUpstreamRequests,
    );
  },
);

for (const fault of [
  "wrong-model-body",
  "missing-tokens",
  "oversized-tokens",
  "wrong-query",
  "wrong-method",
  "wrong-route",
  "endpoint-leak",
  "fresh-foreign-turn",
  "foreign-native-command",
  "foreign-native-session",
  "foreign-native-turn",
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
  "unsolicited-outcome",
  "old-row",
  "wrong-bash",
  "no-read",
  "wrong-read",
  "echo-500",
  "error-200",
  "broken-sse",
  "hang-scan",
  "hang-cleanup",
]) {
  test(
    `same native child rejects ${fault} and scans whole disposable`,
    { timeout: 60000 },
    async () => {
      const { code, report } = await fake(fault);
      assert.equal(code, 1);
      assert.equal(report.scenarioVerified, false);
      if (["agent-compact", "task-multiline", "workflow-compact"].includes(fault)) {
        assert.equal(
          report.fakeUpstreamRequests,
          1,
          "adversarial SSE must reach the guarded Model transport exactly once",
        );
        assert.equal(report.httpDispatches, 1);
        assert.equal(report.forbiddenToolRequests, 0, "no delegated port may run");
        assert.ok(
          report.turns.every(
            (turn) => turn.actions.length === 0 && turn.observedToolNames.length === 0,
          ),
        );
      }
      if (
        [
          "wrong-model-body",
          "missing-tokens",
          "oversized-tokens",
          "wrong-query",
          "wrong-method",
          "wrong-route",
        ].includes(fault)
      ) {
        assert.equal(report.httpAttempts, 1, "a rejected reservation is not a dispatch");
        assert.equal(report.httpDispatches, 0);
        assert.equal(report.fakeUpstreamRequests, 0);
        assert.equal(
          report.modelUsageCalls.reduce((total, call) => total + call.httpReservations, 0),
          1,
        );
      }
      if (
        [
          "fresh-foreign-turn",
          "foreign-native-command",
          "foreign-native-session",
          "foreign-native-turn",
          "stale-session",
          "stale-call",
          "stale-turn",
        ].includes(fault)
      ) {
        assert.equal(
          report.turns.some((turn) => turn.actions.some((action) => action.decision === "allow")),
          false,
        );
        assert.equal(report.effects.allowedWrite, false);
      }
      if (fault === "endpoint-leak") assert.equal(report.privateArtifactScan, false);
      if (fault === "broken-sse")
        assert.ok(report.modelUsageCalls.some((call) => call.coverage === "error-partial"));
      if (fault === "webfetch")
        assert.equal(report.forbiddenToolRequests, 0, "unregistered tool must not run");
      if (fault === "webfetch-exposed")
        assert.ok(
          report.forbiddenToolRequests > 0,
          "preapproved tool must hit denied port, not network",
        );
      if (fault === "hang-scan") assert.equal(report.privateArtifactScan, false);
    },
  );
}

test(
  "same child keeps auxiliary usage with source turn after a newer command starts",
  { timeout: 60000 },
  async () => {
    const { code, report } = await fake("aux-interleave");
    assert.equal(code, 0);
    assert.equal(report.scenarioVerified, true);
    assert.equal(report.auxiliaryCompletedAfterNewTurn, true);
    const auxiliary = report.modelUsageCalls.find(
      (call) => call.purpose === "session_title_generation",
    );
    assert.equal(auxiliary.commandId, report.turns[0].commandId);
    assert.equal(
      auxiliary.coverage,
      "error-partial",
      "a failed title is not fabricated as complete",
    );
    assert.equal(report.usageQualified, false);
  },
);

for (const [fault, status, value] of [
  ["usage-zero", "reported", 0],
  ["usage-absent", "absent", null],
]) {
  test(
    `same child observes actual Model ${fault} without inferring cumulative usage`,
    { timeout: 60000 },
    async () => {
      const { report } = await fake(fault);
      assert.ok(
        report.modelUsageCalls.some(
          (call) =>
            call.metrics.inputTokens.status === status && call.metrics.inputTokens.value === value,
        ),
      );
    },
  );
}

test("late auxiliary usage keeps original native command; wrong or absent identity stays unknown", () => {
  const usage = createPrivateUsage();
  for (const [callId, runtimeTurnId, purpose] of [
    [1, "native-a", "session_title_generation"],
    [2, "native-foreign", "agent_step"],
  ]) {
    usage.observe({
      callId,
      operationKind: "generate",
      phase: "start",
      purpose,
      sessionId: "s",
      runtimeTurnId,
    });
  }
  // Turn B has already started when A's auxiliary finishes: attribution uses captured runtime turn.
  usage.provider({
    callId: 1,
    dispatchId: 1,
    complete: true,
    metrics: { inputTokens: 0, outputTokens: 2 },
  });
  usage.observe({
    callId: 1,
    operationKind: "generate",
    phase: "finish",
    metrics: { inputTokens: 0, outputTokens: 2 },
  });
  usage.provider({ callId: 2, dispatchId: 2, complete: true, metrics: {} });
  usage.observe({ callId: 2, operationKind: "generate", phase: "error" });
  const turns = [
    { commandId: "a", runtimeTurnId: "native-a" },
    { commandId: "b", runtimeTurnId: "native-b" },
  ];
  const result = usage.results(turns, "s");
  assert.equal(result.list[0].commandId, "a");
  assert.equal(result.list[0].purpose, "session_title_generation");
  assert.deepEqual(result.list[0].metrics.inputTokens, { status: "reported", value: 0 });
  assert.equal(result.list[1].commandId, null);
  assert.equal(result.list[1].metrics.inputTokens.status, "absent");
  assert.equal(result.usageCoverage.main, "partial");
});

test(
  "cleanup worker without exit even after SIGKILL is bounded and never reported removed",
  { timeout: 3000 },
  async () => {
    const worker = new EventEmitter();
    let kills = 0;
    worker.kill = () => {
      kills++;
      return false;
    };
    const start = Date.now();
    const removed = await removeBounded("/synthetic-disposable", Date.now() + 90, {
      rootDir: root,
      launch: () => worker,
    });
    assert.equal(removed, false);
    assert.equal(kills, 1);
    assert.ok(Date.now() - start < 1000);
  },
);

test(
  "registered spawn/exit latch: signal before finally and close-after-exit cannot hang",
  { timeout: 5000 },
  async () => {
    const ch = openPrivateChannel(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { stdio: ["pipe", "pipe", "pipe", "ipc"] },
      () => {},
    );
    await assert.rejects(ch.next());
    const result = await ch.reap(Date.now() + 2000);
    assert.equal(result.signal, "SIGTERM");
  },
);
test("registered spawn failure rejects frame waiter and cleanup", { timeout: 5000 }, async () => {
  const ch = openPrivateChannel(
    join(root, "missing-private-executable"),
    [],
    { stdio: ["pipe", "pipe", "pipe", "ipc"] },
    () => {},
  );
  await assert.rejects(ch.next());
  assert.ok(await ch.reap(Date.now() + 2000));
});
test(
  "unexpected EOF/IPC disconnect rejects pending phase/frame reads",
  { timeout: 5000 },
  async () => {
    const eof = openPrivateChannel(
      process.execPath,
      ["-e", "process.stdout.end(); setInterval(()=>{},1000)"],
      { stdio: ["pipe", "pipe", "pipe", "ipc"] },
      () => {},
    );
    await assert.rejects(eof.next(), /EOF/);
    await eof.reap(Date.now() + 2000);
    const ipc = openPrivateChannel(
      process.execPath,
      ["-e", "process.disconnect(); setInterval(()=>{},1000)"],
      { stdio: ["pipe", "pipe", "pipe", "ipc"] },
      () => {},
    );
    await assert.rejects(ipc.next(), /IPC/);
    await ipc.reap(Date.now() + 2000);
  },
);
test("unterminated stdout is byte-bounded before readline", { timeout: 5000 }, async () => {
  const ch = openPrivateChannel(
    process.execPath,
    ["-e", "process.stdout.write('X'.repeat(1100000)); setInterval(()=>{},1000)"],
    { stdio: ["pipe", "pipe", "pipe", "ipc"] },
    () => {},
  );
  await assert.rejects(ch.next(), /budget/);
  await ch.reap(Date.now() + 2000);
});
