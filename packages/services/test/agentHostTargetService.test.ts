import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

test("target service admits only authorized workspaces, detaches without stopping and replays history", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-target-host-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const spec = {
    schemaVersion: 2 as const, projectId: "project-a", workspaceId: "workspace-a", hostSessionId: "host-a",
    execution: { targetId: "target-a", workspaceIdentity: "workspace-a", worktreePath: worktree, worktreeGeneration: "generation-a", cwdRelativeToWorktree: "." },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: { kind: "host-managed" as const, selection: { providerId: "provider-a", modelId: "model-a" } },
  };
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.registerTrusted({ schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" }, () => mock);
  const service = new AgentHostTargetService({
    root: join(root, "host"), target: { id: "target-a", kind: "local", platform: process.platform as "darwin" | "linux", available: true },
    catalog, registry, admission: { verify: async (candidate) => { if (candidate.execution.workspaceIdentity !== "workspace-a" || candidate.execution.worktreePath !== worktree) throw new Error("unauthorized"); return { canonicalCwd: worktree }; }, withAdmission: async (candidate, action) => { if (candidate.execution.workspaceIdentity !== "workspace-a" || candidate.execution.worktreePath !== worktree) throw new Error("unauthorized"); return action({ canonicalCwd: worktree }); } },
  });
  try {
    assert.deepEqual(await service.getAvailability(), {
      target: { id: "target-a", kind: "local", platform: process.platform, available: true },
      harnesses: ["mock"],
    });
    await assert.rejects(service.create({ ...spec, execution: { ...spec.execution, workspaceIdentity: "foreign" } }, "foreign"), /unauthorized/);
    const created = await service.create(spec, "create-host-a");
    assert.equal(created.agentHost?.harnessId, "mock");
    const send = { type: "send", commandId: "send-1", hostSessionId: "host-a", turnId: "turn-1", text: "mock text" } as const;
    assert.equal((await service.dispatch(spec, send)).status, "accepted");
    await mock.waitForInteraction("host-a");
    const before = await service.snapshot(spec);
    assert.equal(before.control.canStop, true);
    assert.equal((await service.dispatch(spec, { type: "detach", commandId: "detach-1", hostSessionId: "host-a" })).status, "completed");
    assert.equal((await service.snapshot(spec)).pendingInteractions.length, 1);
    await service.dispatch(spec, { type: "resolveInteraction", commandId: "deny-1", hostSessionId: "host-a", runtimeEpoch: before.logEpoch, turnId: "turn-1", interactionId: "approval-1", decision: "deny" });
    const terminal = await service.waitForIdle(spec);
    assert.equal(terminal.rows.window.some((row) => row.kind === "assistantText"), true);
    assert.equal((await service.queryCommand(spec, "send-1"))?.status, "completed");
    assert.equal((await service.dispatch(spec, { type: "terminateSession", commandId: "term-1", hostSessionId: "host-a" })).status, "completed");
    await service.close();
    // The new process has no harness adapter or credentials. History is still
    // available and attach cannot accidentally recreate a terminated backend.
    const history = new AgentHostTargetService({
      root: join(root, "host"), target: { id: "target-a", kind: "local", platform: process.platform as "darwin" | "linux", available: true },
      catalog, registry: new HarnessRegistry(), admission: { verify: async () => { throw new Error("history only"); }, withAdmission: async () => { throw new Error("history only"); } },
    });
    assert.deepEqual((await history.listSessions("workspace-a", worktree)).map((item) => [item.spec.hostSessionId, item.state]), [["host-a", "terminated"]]);
    assert.deepEqual(await history.listSessions("foreign", worktree), []);
    assert.equal((await history.snapshot(spec)).rows.window.some((row) => row.kind === "assistantText"), true);
    assert.ok((await history.eventsSince(spec, 0)).length > 0);
    assert.equal((await history.queryCommand(spec, "send-1"))?.status, "completed");
    await assert.rejects(history.attach(spec), /history only|terminated/);
    await history.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
