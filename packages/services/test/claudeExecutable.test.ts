import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExecutionTarget } from "@zcode/shared/agent-host";
import {
  probeClaudeTarget,
  readClaudeCliVersion,
  resolveClaudeExecutable,
} from "../src/agent-adapters/claude/claudeExecutable.js";

// Unit coverage for CLI discovery and the isolated version probe, using shell stubs for `claude`.
const POSIX = { skip: process.platform === "win32" };

const localTarget: ExecutionTarget = {
  id: "local",
  kind: "local",
  platform: process.platform as "darwin" | "linux" | "win32",
  available: true,
};

async function scratch(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-exe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function stub(path: string, body: string, mode = 0o700): Promise<string> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, mode);
  return path;
}

test("an explicit executable path is used as-is and never falls back to PATH", POSIX, async (t) => {
  const root = await scratch(t);
  const explicit = await stub(join(root, "my-claude"), "exit 0");
  assert.equal(await resolveClaudeExecutable(explicit), explicit);
  const notExecutable = await stub(join(root, "plain"), "exit 0", 0o600);
  await assert.rejects(resolveClaudeExecutable(notExecutable), /not found in the explicit path/);
  await assert.rejects(resolveClaudeExecutable(join(root, "missing")), /not found/);
});

test(
  "PATH lookup takes the first executable `claude` and skips empty entries",
  POSIX,
  async (t) => {
    const root = await scratch(t);
    const firstDir = join(root, "first");
    const secondDir = join(root, "second");
    await Promise.all([mkdir(firstDir), mkdir(secondDir)]);
    const saved = process.env.PATH;
    t.after(() => {
      process.env.PATH = saved;
    });
    await stub(join(firstDir, "claude"), "exit 0", 0o600);
    const expected = await stub(join(secondDir, "claude"), "exit 0");
    process.env.PATH = ["", firstDir, "", secondDir].join(delimiter);
    assert.equal(await resolveClaudeExecutable(), expected);
    process.env.PATH = "";
    await assert.rejects(resolveClaudeExecutable(), /not found in the explicit path or PATH/);
  },
);

test("the version probe runs in a throwaway HOME/config dir and removes it", POSIX, async (t) => {
  const root = await scratch(t);
  const report = join(root, "report.txt");
  const executable = await stub(
    join(root, "claude"),
    `printf '%s|%s|%s|%s' "$PWD" "$HOME" "$CLAUDE_CONFIG_DIR" "$ANTHROPIC_API_KEY" > '${report}'\n` +
      "echo '2.1.263 (Claude Code)'",
  );
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  t.after(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  });
  assert.equal(await readClaudeCliVersion(executable), "2.1.263");
  const [cwd, home, configDir, apiKey] = (await readFile(report, "utf8")).split("|");
  assert.match(cwd!, /zcode-claude-version-/);
  assert.equal(home, cwd);
  assert.equal(configDir, join(cwd!, "claude-config"));
  assert.equal(apiKey, "", "the probe environment is an allow-list");
  assert.equal(existsSync(cwd!), false, "the scratch directory is removed");
});

test("unparseable version output and a failing CLI are errors", POSIX, async (t) => {
  const root = await scratch(t);
  const garbled = await stub(join(root, "garbled"), "echo 'Claude Code v2'");
  await assert.rejects(readClaudeCliVersion(garbled), /version output is invalid/);
  const failing = await stub(join(root, "failing"), "exit 4");
  await assert.rejects(readClaudeCliVersion(failing));
});

test("probeClaudeTarget refuses unavailable, remote and foreign-platform targets first", async () => {
  const unavailable = await probeClaudeTarget({ ...localTarget, available: false });
  assert.deepEqual(unavailable, { support: "unsupported", reason: "target unavailable" });
  const reasoned = await probeClaudeTarget({ ...localTarget, available: false, reason: "offline" });
  assert.equal(reasoned.reason, "offline");
  const foreign = process.platform === "win32" ? "linux" : "win32";
  for (const target of [
    { ...localTarget, kind: "ssh" },
    { ...localTarget, platform: foreign },
  ] as ExecutionTarget[]) {
    assert.match((await probeClaudeTarget(target)).reason ?? "", /must run on its local/);
  }
});

test("probeClaudeTarget reports an unpinned or unusable CLI as unsupported", POSIX, async (t) => {
  const root = await scratch(t);
  const unpinned = await stub(join(root, "unpinned"), "echo '2.1.264'");
  assert.deepEqual(await probeClaudeTarget(localTarget, unpinned), {
    support: "unsupported",
    reason: "Claude Code CLI version is not pinned 2.1.263",
  });
  const broken = await stub(join(root, "broken"), "exit 1");
  for (const executable of [broken, join(root, "missing")]) {
    const probe = await probeClaudeTarget(localTarget, executable);
    assert.equal(probe.support, "unsupported");
    assert.match(probe.reason ?? "", /unavailable or failed its isolated version check/);
  }
});
