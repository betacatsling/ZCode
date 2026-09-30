import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDevinHarness,
  createExperimentalRegistryDevinHarness,
  DEVIN_ADAPTER_VERSION,
} from "../src/agent-adapters/devin/createDevinHarness.js";
import { probeDevinTarget } from "../src/agent-adapters/devin/devinExecutable.js";
import { devinHarnessCapabilities } from "../src/agent-adapters/devin/devinCapabilities.js";
import { DEVIN_HARNESS_MANIFEST } from "../src/agent-host/harnessDirectory.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import type { AgentEvent, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";

const localTarget = {
  id: "local",
  kind: "local" as const,
  platform: process.platform as "darwin" | "linux" | "win32",
  available: true,
};

function planFor(hostSessionId: string): BindingPlan {
  return {
    schemaVersion: 1,
    hostSessionId,
    targetId: "local",
    harnessId: "devin",
    adapterVersion: "0.1.0",
    catalogFingerprint: "fp",
    requested: { kind: "harness-managed" },
    route: "harness-managed",
    support: { support: "experimental", reason: "test" },
    capabilities: {},
  };
}

function specFor(hostSessionId: string, worktreePath: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    harness: { id: "devin", adapterVersion: "0.1.0" },
    execution: {
      targetId: "local",
      workspaceIdentity: "ws",
      worktreePath,
    },
    modelBinding: { kind: "harness-managed" },
  };
}

test("Devin factory id/version match DEVIN_HARNESS_MANIFEST", () => {
  const harness = createExperimentalRegistryDevinHarness({ root: "/tmp/zcode-devin" });
  assert.equal(harness.id, "devin");
  assert.equal(harness.version, "0.1.0");
  assert.equal(harness.version, DEVIN_ADAPTER_VERSION);
  assert.equal(harness.version, DEVIN_HARNESS_MANIFEST.adapterVersion);
  assert.equal(harness.id, DEVIN_HARNESS_MANIFEST.id);
  assert.equal(harness.hostManagedRoute, "harness-managed");
  assert.equal(createDevinHarness({ root: "/tmp/zcode-devin" }).id, "devin");
});

test("Devin registers once on HarnessRegistry", () => {
  const registry = new HarnessRegistry();
  registry.register(createExperimentalRegistryDevinHarness({ root: "/tmp/zcode-devin" }));
  assert.equal(registry.require("devin").version, "0.1.0");
  assert.throws(
    () => registry.register(createExperimentalRegistryDevinHarness({ root: "/tmp/zcode-devin" })),
    /duplicate or invalid harness: devin/,
  );
});

test(
  "Devin probe is supported when a CLI stub answers --version",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-devin-probe-"));
    const executable = join(root, "devin");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('devin 0.0.1\\n');\n", {
      mode: 0o700,
    });
    await chmod(executable, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));

    const report = await probeDevinTarget(localTarget, executable);
    assert.equal(report.support, "supported");
    assert.match(report.reason ?? "", /print mode/i);
    assert.match(report.reason ?? "", /-p/);
    assert.match(report.reason ?? "", /does not certify/i);
  },
);

test("Devin probe is unsupported when CLI is missing", async () => {
  const report = await probeDevinTarget(
    localTarget,
    join(tmpdir(), "zcode-missing-devin-cli-does-not-exist"),
  );
  assert.equal(report.support, "unsupported");
  assert.match(report.reason ?? "", /unavailable|failed/i);
});

test("Devin capabilities stay print-mode honest on every field", () => {
  const caps = devinHarnessCapabilities();
  assert.equal(caps.text.support, "experimental");
  assert.match(caps.text.reason ?? "", /print mode/i);
  assert.match(caps.text.reason ?? "", /-p/);
  assert.equal(caps.cancelTurn.support, "experimental");
  assert.match(caps.cancelTurn.reason ?? "", /print-mode/i);
  assert.match(caps.cancelTurn.reason ?? "", /-p/);

  const unsupported = [
    "tools",
    "approvals",
    "history",
    "resumeExecution",
    "images",
    "modelSwitch",
  ] as const;
  for (const field of unsupported) {
    assert.equal(caps[field].support, "unsupported", field);
    assert.match(caps[field].reason ?? "", /print mode/i, field);
    assert.match(caps[field].reason ?? "", /-p/, field);
    for (const named of unsupported) {
      assert.match(caps[field].reason ?? "", new RegExp(named), field);
    }
  }

  assert.equal(caps.detach, undefined);
  assert.equal(caps.terminateSession, undefined);
  assert.equal(caps.viewHistory, undefined);
  assert.equal(caps.hostManagedModel, undefined);
});

test(
  "Devin create + print-mode send emits a full turn",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-devin-print-"));
    const worktree = join(root, "ws");
    await mkdir(worktree, { recursive: true });
    const executable = join(root, "devin");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "const logPath = path.join(path.dirname(process.argv[1]), 'devin-argv.log');",
        "fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');",
        "if (args.includes('--version') || args[0] === 'version') {",
        "  process.stdout.write('devin 0.0.1\\n');",
        "  process.exit(0);",
        "}",
        "const trust = args.indexOf('--respect-workspace-trust');",
        "if (args[0] !== '-p' || trust < 0 || args[trust + 1] !== 'false' || !args.includes('--')) {",
        "  process.stderr.write('expected print-mode argv\\n');",
        "  process.exit(2);",
        "}",
        "process.stdout.write('hello from fake devin');",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));

    const harness = createExperimentalRegistryDevinHarness({
      root,
      executablePath: executable,
    });
    const events: AgentEvent[] = [];
    const hostSessionId = "devin-print-1";
    harness.subscribe(hostSessionId, (event) => events.push(event));

    const binding = await harness.create(specFor(hostSessionId, worktree), planFor(hostSessionId));
    assert.equal(binding.hostSessionId, hostSessionId);
    assert.match(binding.backendSessionId, /^devin-print-/);

    await harness.send({
      type: "send",
      commandId: "cmd-1",
      hostSessionId,
      turnId: "turn-1",
      text: "say hello",
    });

    const kinds = events.map((event) => event.kind);
    assert.deepEqual(kinds, ["turn.started", "text.delta", "message.finished", "turn.finished"]);
    const finished = events.find((event) => event.kind === "message.finished");
    assert.ok(finished && finished.kind === "message.finished");
    assert.equal(finished.text, "hello from fake devin");
    const turn = events.find((event) => event.kind === "turn.finished");
    assert.ok(turn && turn.kind === "turn.finished");
    assert.equal(turn.outcome, "success");

    const logged = await readFile(join(root, "devin-argv.log"), "utf8");
    const invocations = logged
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const print = invocations.find((args) => args.includes("-p"));
    assert.ok(print);
    assert.deepEqual(print.slice(0, 4), ["-p", "--respect-workspace-trust", "false", "--"]);
    assert.equal(print.includes("-c"), false);
    assert.equal(print.includes("-r"), false);
    assert.equal(print.includes("acp"), false);
    assert.equal(print.includes("--cloud"), false);
  },
);
