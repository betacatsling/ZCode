import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCommand } from "@zcode/shared/agent-host";
import { CommandJournal } from "../src/agent-host/commandJournal.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

test("an uncertain send in the current owner also fences subsequent prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-current-unknown-fence-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const spec = { schemaVersion: 2 as const, projectId: "project-a", workspaceId: "workspace-a", hostSessionId: "h", execution: { targetId: "t", workspaceIdentity: "w", worktreePath: worktree, worktreeGeneration: "generation-a", cwdRelativeToWorktree: "." },
    harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } } };
  const target = { id: "t", kind: "local" as const, platform: process.platform as "darwin" | "linux", available: true };
  let calls = 0;
  class UncertainHarness extends MockHarness {
    override async send(_command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
      calls++;
      throw new Error("backend response lost");
    }
  }
  const registry = new HarnessRegistry();
  registry.register(new UncertainHarness());
  const host = await SessionHost.create({ root: join(root, "data"), spec, target, registry,
    catalog: { fingerprint: "v1", validateSelection: () => ({ ok: true }) } });
  try {
    assert.equal((await host.dispatch({ type: "send", commandId: "s1", hostSessionId: "h", turnId: "t1", text: "maybe executed" })).status, "accepted");
    await host.whenIdle();
    assert.equal(host.queryCommand("s1")?.status, "execution-unknown");
    const next = await host.dispatch({ type: "send", commandId: "s2", hostSessionId: "h", turnId: "t2", text: "must not execute" });
    assert.equal(next.status, "rejected");
    assert.equal(next.reasonCode, "execution-unknown");
    assert.equal(calls, 1);
    assert.equal((await host.dispatch({ type: "viewHistory", commandId: "history", hostSessionId: "h" })).status, "completed");
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a prior uncertain send fences new prompts after host restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-recovery-fence-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const data = join(root, "data");
  const spec = { schemaVersion: 2 as const, projectId: "project-a", workspaceId: "workspace-a", hostSessionId: "h", execution: { targetId: "t", workspaceIdentity: "w", worktreePath: worktree, worktreeGeneration: "generation-a", cwdRelativeToWorktree: "." },
    harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding: { kind: "host-managed" as const, selection: { providerId: "p", modelId: "m" } } };
  const target = { id: "t", kind: "local" as const, platform: process.platform as "darwin" | "linux", available: true };
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.register(mock);
  let host: SessionHost | undefined;
  try {
    host = await SessionHost.create({ root: data, spec, target, registry, catalog: { fingerprint: "v1", validateSelection: () => ({ ok: true }) } });
    const identity = { targetId: "t", workspaceIdentity: "w", harnessId: "mock", hostSessionId: "h", runtimeEpoch: host.binding.runtimeEpoch };
    await host.close();
    host = undefined;
    const journal = await CommandJournal.open(data, identity);
    await journal.accept({ type: "send", commandId: "lost-ack", hostSessionId: "h", turnId: "t1", text: "possibly ran" });
    await journal.close();
    host = await SessionHost.open({ root: data, spec, target, registry, catalog: { fingerprint: "v1", validateSelection: () => ({ ok: true }) } });
    assert.equal(host.queryCommand("lost-ack")?.status, "execution-unknown");
    const receipt = await host.dispatch({ type: "send", commandId: "new-send", hostSessionId: "h", turnId: "t2", text: "do not run" });
    assert.equal(receipt.status, "rejected");
    assert.equal(receipt.reasonCode, "execution-unknown");
    assert.equal(host.snapshot().rows.window.length, 0);
    assert.equal((await host.dispatch({ type: "viewHistory", commandId: "view", hostSessionId: "h" })).status, "completed");
    await host.close();
    host = undefined;
  } finally {
    await host?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
