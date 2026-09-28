import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExperimentalRegistryDevinHarness } from "../src/agent-adapters/devin/createDevinHarness.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

/**
 * Wave 2.5-B: same factory lazyTargetService registers, through SessionHost,
 * with a fake `devin -p` CLI so create/send land in the Host journal.
 */
test(
  "SessionHost + lazy Devin factory: create/send journals a print-mode turn",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-devin-sessionhost-"));
    const worktree = join(root, "worktree");
    const journalRoot = join(root, "journal");
    await mkdir(worktree, { recursive: true });
    const executable = join(root, "devin");
    await writeFile(
      executable,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('--version') || args[0] === 'version') {",
        "  process.stdout.write('devin 0.0.1\\n');",
        "  process.exit(0);",
        "}",
        "if (!args.includes('-p')) {",
        "  process.stderr.write('expected -p\\n');",
        "  process.exit(2);",
        "}",
        "process.stdout.write('journaled from fake Devin');",
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));

    const registry = new HarnessRegistry();
    // Mirrors lazyTargetService: createExperimentalRegistryDevinHarness({ root })
    registry.register(
      createExperimentalRegistryDevinHarness({
        root: join(root, "workers"),
        executablePath: executable,
      }),
    );

    const hostSessionId = "devin-host-1";
    const spec = {
      schemaVersion: 1 as const,
      hostSessionId,
      execution: {
        targetId: "local",
        workspaceIdentity: "workspace-devin",
        worktreePath: worktree,
      },
      harness: { id: "devin", adapterVersion: "0.1.0" },
      modelBinding: { kind: "harness-managed" as const },
    };
    const target = {
      id: "local",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    };
    const catalog = {
      fingerprint: "registry-v1",
      validateSelection: () => ({ ok: true as const }),
    };

    const host = await SessionHost.create({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
    assert.equal(host.plan.route, "harness-managed");
    assert.equal(host.plan.support.support, "supported");
    assert.match(host.binding.backendSessionId, /^devin-print-/);

    const receipt = await host.dispatch({
      type: "send",
      commandId: "devin-cmd-1",
      hostSessionId,
      turnId: "turn-1",
      text: "say hello for the journal",
    });
    assert.equal(receipt.status, "accepted");
    await host.whenIdle();
    assert.equal(host.queryCommand("devin-cmd-1")?.status, "completed");

    const events = host.eventsSince(0);
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes("turn.started"));
    assert.ok(kinds.includes("text.delta"));
    assert.ok(kinds.includes("message.finished"));
    assert.ok(kinds.includes("turn.finished"));
    const message = events.find((event) => event.kind === "message.finished");
    assert.ok(message && message.kind === "message.finished");
    assert.equal(message.text, "journaled from fake Devin");
    const turn = events.find((event) => event.kind === "turn.finished");
    assert.ok(turn && turn.kind === "turn.finished");
    assert.equal(turn.outcome, "success");

    await host.close();

    const history = await SessionHost.snapshotHistory(journalRoot, spec);
    assert.ok(history.seq > 0);
    const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
    assert.ok(persisted.some((event) => event.kind === "message.finished"));
    assert.ok(persisted.some((event) => event.kind === "turn.finished"));
  },
);
