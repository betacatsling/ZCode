import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeStreamProcess,
  type ClaudeStructuredMessage,
} from "../src/agent-adapters/claude/claudeStreamProcess.js";

// Unit coverage for the structured stdio pipe, driven by small `node -e` children instead of the
// pinned CLI: line framing, every refused line, stdin framing, and terminate/abort ownership.

function start(script: string, onMessage?: (message: ClaudeStructuredMessage) => void) {
  const messages: ClaudeStructuredMessage[] = [];
  const failures: string[] = [];
  const stream = new ClaudeStreamProcess({
    executablePath: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    onMessage: (message) => {
      messages.push(message);
      onMessage?.(message);
    },
    onFailure: (error) => failures.push(error.message),
  });
  return { stream, messages, failures };
}

// Keeps a child alive until it is terminated; the pipe must not be what ends it.
const LINGER = "setInterval(() => {}, 1000);";

test("split chunks are reassembled into lines; blank lines skip; exit 0 is not a failure", async () => {
  const { stream, messages, failures } = start(`
    process.stdout.write('{"type":"a","n":1}\\n\\n  \\n{"type":');
    setTimeout(() => process.stdout.write('"b"}\\n'), 20);
  `);
  assert.equal(typeof stream.pid, "number");
  assert.deepEqual(await stream.closed, { code: 0, signal: null });
  assert.equal(stream.isRunning, false);
  assert.deepEqual(messages, [{ type: "a", n: 1 }, { type: "b" }]);
  assert.deepEqual(failures, []);
});

for (const [name, line, reason] of [
  ["non-JSON", "not json", "Claude Code emitted a non-JSON structured stream line"],
  ["JSON-array", "[1]", "Claude Code emitted an invalid structured stream message"],
  ["typeless", '{"kind":"x"}', "Claude Code emitted an invalid structured stream message"],
] as const) {
  test(`a ${name} line fails once and aborts the child`, async () => {
    const { stream, messages, failures } = start(
      `process.stdout.write(${JSON.stringify(`${line}\n{"type":"after"}\n`)}); ${LINGER}`,
    );
    await stream.closed;
    assert.deepEqual(failures, [reason]);
    assert.deepEqual(messages, []);
    assert.equal(stream.isRunning, false);
  });
}

test("a translator exception fails the stream instead of escaping the pipe", async () => {
  const { stream, failures } = start(`process.stdout.write('{"type":"x"}\\n'); ${LINGER}`, () => {
    throw new Error("translator bug");
  });
  await stream.closed;
  assert.deepEqual(failures, ["Claude structured stream event could not be translated"]);
});

test("an oversized unterminated line fails before it is buffered further", async () => {
  const { stream, failures } = start(
    `process.stdout.write('{"type":"x","pad":"' + 'a'.repeat(8 * 1024 * 1024) + '"'); ${LINGER}`,
  );
  await stream.closed;
  assert.deepEqual(failures, ["Claude structured stream line exceeded its size limit"]);
});

test("an unexpected exit reports the dangling line and the missing terminal result", async () => {
  const { stream, failures } = start(`process.stdout.write('{"type":"half"'); process.exit(3);`);
  assert.equal((await stream.closed).code, 3);
  assert.deepEqual(failures, [
    "Claude Code ended with an incomplete structured stream line",
    "Claude Code process exited without a terminal result",
  ]);
});

test("a spawn error is one failure and closes the stream", async () => {
  const failures: string[] = [];
  const stream = new ClaudeStreamProcess({
    executablePath: "/nonexistent/claude-ex1-unit",
    args: [],
    cwd: process.cwd(),
    env: {},
    onMessage: () => undefined,
    onFailure: (error) => failures.push((error as NodeJS.ErrnoException).code ?? error.message),
  });
  await stream.closed;
  assert.deepEqual(failures, ["ENOENT"]);
  assert.equal(stream.isRunning, false);
});

test("sendUserMessage frames one JSON user line; terminate closes stdin and waits", async () => {
  const { stream, messages, failures } = start(`
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      process.stdout.write(JSON.stringify({ type: "echo", input }) + "\\n");
    });
    process.stdin.on("end", () => process.exit(0));
  `);
  await stream.sendUserMessage('hi "there"\n');
  while (messages.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(JSON.parse((messages[0]!.input as string).trim()), {
    type: "user",
    message: { role: "user", content: 'hi "there"\n' },
  });
  await Promise.all([stream.terminate(), stream.terminate()]);
  assert.deepEqual(await stream.closed, { code: 0, signal: null });
  assert.deepEqual(failures, []);
  await assert.rejects(stream.sendUserMessage("late"), /not accepting structured input/);
  await stream.terminate();
  await stream.abort();
});

test("abort kills a child that ignores stdin EOF and suppresses exit failures", async () => {
  const { stream, failures } = start(`process.stdin.resume(); ${LINGER}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const began = Date.now();
  await Promise.all([stream.abort(), stream.abort()]);
  assert.ok(Date.now() - began < 4_000, "abort must not wait for the 5 s stdin grace period");
  assert.equal(stream.isRunning, false);
  const closed = await stream.closed;
  assert.ok(closed.signal !== null || closed.code !== 0, "the child was killed, not exited");
  assert.deepEqual(failures, []);
});
