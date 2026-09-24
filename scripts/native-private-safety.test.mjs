import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openPrivateChannel } from "./native-private-channel.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));

async function fake(fault, implicit = false) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/native-private-runner.mjs", ...(implicit ? [] : ["--fake"])], {
    cwd: root, env: { ...process.env, ...(fault ? { ZCODE_NATIVE_FAKE_FAULT: fault } : {}) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; assert.ok(stdout.length < 65536); });
  child.stderr.on("data", (chunk) => { stderr += chunk; assert.ok(stderr.length < 8192); });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(stderr.includes("fixture-private-key-sentinel"), false);
  const report = JSON.parse(stdout.trim());
  assert.equal(stdout.includes("fixture-private-key-sentinel"), false);
  assert.equal(report.cleanup, true);
  if (fault !== "hang-scan") assert.equal(report.privateArtifactScan, true);
  else assert.equal(report.privateArtifactScan, false);
  if (fault !== "hang-scan") assert.equal(report.childExit, 0);
  assert.equal(report.httpDispatches, report.fakeUpstreamRequests);
  assert.equal(report.fakeForbiddenRequests, 0);
  return { code, report };
}

test("default mode uses same child/controller; wrong route and help never select live", { timeout: 60000 }, async () => {
  const { code, report } = await fake(undefined, true);
  assert.equal(code, 0);
  assert.equal(report.mode, "fake");
  assert.equal(report.scenarioVerified, true);
  for (const args of [["--help"], ["--live", "unapproved/model"], ["--live"]]) {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/native-private-runner.mjs", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: join(root, "missing-profile") } });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.resume();
    const status = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(status, args[0] === "--help" ? 0 : 2);
    assert.equal(out.includes("privateArtifactScan"), false);
  }
});

test("same fake/live V4 orchestrator completes three isolated turns and private scan", { timeout: 60000 }, async () => {
  const { code, report } = await fake();
  assert.equal(code, 0);
  assert.equal(report.scenarioVerified, true);
  assert.equal(report.matchingTerminals, 3);
  assert.deepEqual(Object.values(report.effects), [true, true, true, true]);
  assert.ok(report.httpAttempts <= 12 && report.modelCalls.stream > 0);
});

for (const fault of ["webfetch", "webfetch-exposed", "other-tool", "wrong-write", "extra-cwd", "stale-session", "stale-call", "stale-turn", "unsolicited-outcome", "old-row", "wrong-bash", "no-read", "wrong-read", "echo-500", "error-200", "broken-sse", "hang-scan", "hang-cleanup"]) {
  test(`same native child rejects ${fault} and scans whole disposable`, { timeout: 60000 }, async () => {
    const { code, report } = await fake(fault);
    assert.equal(code, 1);
    assert.equal(report.scenarioVerified, false);
    if (fault === "webfetch") assert.equal(report.forbiddenToolRequests, 0, "unregistered tool must not run");
    if (fault === "webfetch-exposed") assert.ok(report.forbiddenToolRequests > 0, "preapproved tool must hit denied port, not network");
    if (fault === "hang-scan") assert.equal(report.privateArtifactScan, false);
  });
}

test("registered spawn/exit latch: signal before finally and close-after-exit cannot hang", { timeout: 5000 }, async () => {
  const ch = openPrivateChannel(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { stdio: ["pipe", "pipe", "pipe", "ipc"] }, () => {});
  await assert.rejects(ch.next());
  const result = await ch.reap(Date.now() + 2000);
  assert.equal(result.signal, "SIGTERM");
});
test("registered spawn failure rejects frame waiter and cleanup", { timeout: 5000 }, async () => {
  const ch = openPrivateChannel(join(root, "missing-private-executable"), [], { stdio: ["pipe", "pipe", "pipe", "ipc"] }, () => {});
  await assert.rejects(ch.next());
  assert.ok(await ch.reap(Date.now() + 2000));
});
test("unexpected EOF/IPC disconnect rejects pending phase/frame reads", { timeout: 5000 }, async () => {
  const eof = openPrivateChannel(process.execPath, ["-e", "process.stdout.end(); setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe", "ipc"] }, () => {});
  await assert.rejects(eof.next(), /EOF/);
  await eof.reap(Date.now() + 2000);
  const ipc = openPrivateChannel(process.execPath, ["-e", "process.disconnect(); setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe", "ipc"] }, () => {});
  await assert.rejects(ipc.next(), /IPC/);
  await ipc.reap(Date.now() + 2000);
});
test("unterminated stdout is byte-bounded before readline", { timeout: 5000 }, async () => {
  const ch = openPrivateChannel(process.execPath, ["-e", "process.stdout.write('X'.repeat(1100000)); setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe", "ipc"] }, () => {});
  await assert.rejects(ch.next(), /budget/);
  await ch.reap(Date.now() + 2000);
});
