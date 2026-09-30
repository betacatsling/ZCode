import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ClaudeStreamProcess } from "../src/agent-adapters/claude/claudeStreamProcess.js";
import { claudeAdapterHarness, eventsOf, startTurn } from "./fixtures/claudeAdapterHarness.js";

// A7: the launchProcess hook replaces executable discovery + spawn; unset keeps the pinned CLI path.

test("launchProcess skips executable discovery and receives the pinned spawn options", async (t) => {
  const h = await claudeAdapterHarness(t, {
    behavior: { onSend: (process) => process.result() },
  });
  const binding = await h.adapter.create(h.spec, h.plan);
  assert.equal(
    h.launches.length,
    1,
    "the configured executable does not exist, yet startup launched",
  );
  const process = h.launches[0]!;
  assert.equal(process.options.executablePath, join(h.root, "missing-claude"));
  assert.equal(process.options.cwd, h.spec.execution.worktreePath);
  assert.equal(process.nativeSessionId, binding.backendSessionId);
  assert.equal(process.resumed, false);
  for (const flag of ["--print", "--input-format", "--settings", "--tools"])
    assert.ok(process.options.args.includes(flag), flag);
  assert.match(process.options.env.ANTHROPIC_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+/);
  assert.equal(process.options.env.CLAUDE_CODE_EFFORT_LEVEL, "low");
  assert.deepEqual(h.onProcess, [{ hostSessionId: h.spec.hostSessionId, process }]);
  assert.equal(h.grants.created.length, 1);
  assert.deepEqual(h.grants.revoked, []);
  assert.equal(await process.gatewayStatus(), 400, "the helper token authorizes Gateway requests");

  await (
    await startTurn(h, "turn-hook-1")
  ).sending;
  assert.deepEqual(process.sent, ["run turn-hook-1"]);
  assert.deepEqual(
    eventsOf(h.events, "turn.finished").map((event) => event.outcome),
    ["success"],
  );

  await h.adapter.terminate(h.spec.hostSessionId);
  assert.deepEqual(process.calls, ["terminate"]);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  assert.equal(await process.gatewayStatus(), 401, "terminate revokes the grant");
  assert.equal(await process.preToolUse("tool-1", "Read", { file_path: "x" }), "unreachable");
});

test("without launchProcess startup still version-checks and spawns the pinned CLI", async (t) => {
  const h = await claudeAdapterHarness(t, { adapter: { launchProcess: undefined } });
  const wrongVersion = join(h.root, "claude-2.0.0");
  await writeFile(wrongVersion, '#!/bin/sh\necho "2.0.0 (Claude Code)"\n', { mode: 0o700 });
  const pinned = join(h.root, "claude-2.1.263");
  await writeFile(
    pinned,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.263 (Claude Code)"; exit 0; fi\nexec cat >/dev/null\n',
    { mode: 0o700 },
  );

  const mismatched = await claudeAdapterHarness(t, {
    adapter: { launchProcess: undefined, executablePath: wrongVersion },
  });
  await assert.rejects(
    mismatched.adapter.create(mismatched.spec, mismatched.plan),
    /Claude Code CLI version does not match 2\.1\.263/,
  );
  assert.deepEqual(mismatched.grants.created, [], "the version check runs before any grant");
  assert.deepEqual(mismatched.onProcess, []);

  const spawned = await claudeAdapterHarness(t, {
    adapter: { launchProcess: undefined, executablePath: pinned },
  });
  await spawned.adapter.create(spawned.spec, spawned.plan);
  assert.equal(spawned.launches.length, 0);
  const [entry] = spawned.onProcess;
  assert.ok(entry?.process instanceof ClaudeStreamProcess, "the default path spawns the CLI");
  assert.equal(typeof entry.process.pid, "number");
  assert.equal(entry.process.isRunning, true);
  await spawned.adapter.terminate(spawned.spec.hostSessionId);
  assert.equal(entry.process.isRunning, false);
  assert.deepEqual(spawned.grants.revoked, spawned.grants.created);
});
