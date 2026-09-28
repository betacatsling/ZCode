import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCommand, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const catalog = { fingerprint: "index-test", validateSelection: () => ({ ok: true as const }) };

function session(
  hostSessionId: string,
  worktreePath: string,
  workspaceIdentity: string,
): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: { targetId: "target-a", workspaceIdentity, worktreePath },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
}

function target(): ExecutionTarget {
  return {
    id: "target-a",
    kind: "local",
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
}

test("target activity index is complete, bounded, and history survives a removed worktree", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-agent-activity-index-"));
  const data = join(temp, "host-data");
  const firstWorktree = join(temp, "worktree-one");
  const secondWorktree = join(temp, "worktree-hidden");
  await mkdir(firstWorktree);
  await mkdir(secondWorktree);
  const firstSpec = session("session-one", firstWorktree, "workspace-one");
  const secondSpec = session("session-two", secondWorktree, "workspace-hidden");
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.register(mock);
  const service = new AgentHostTargetService({
    root: data,
    target: target(),
    catalog,
    registry,
    authorizeWorktree: async () => true,
  });
  let history: AgentHostTargetService | undefined;
  try {
    await service.create(firstSpec);
    await service.create(secondSpec);
    const initial = await service.listActivityIndex();
    assert.equal(initial.complete, true);
    assert.equal(
      initial.sessions.length,
      2,
      "unlisted/hidden workspaces remain in target execution facts",
    );
    assert.deepEqual(
      initial.sessions
        .map((entry) => [entry.spec.hostSessionId, entry.state])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
      [
        ["session-one", "idle"],
        ["session-two", "idle"],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );

    const send: Extract<AgentCommand, { type: "send" }> = {
      type: "send",
      commandId: "send-one",
      hostSessionId: firstSpec.hostSessionId,
      turnId: "turn-one",
      text: "write through the mock harness",
    };
    assert.equal((await service.dispatch(firstSpec, send)).status, "accepted");
    await mock.waitForInteraction(firstSpec.hostSessionId);
    const pending = (await service.listActivityIndex()).sessions.find(
      (entry) => entry.spec.hostSessionId === firstSpec.hostSessionId,
    );
    assert.ok(pending);
    assert.equal(pending.state, "busy");
    assert.equal(pending.activeTurnId, "turn-one");
    assert.deepEqual(pending.pendingInteractionIds, ["approval-1"]);
    assert.ok(pending.runtimeEpoch);
    assert.ok(pending.sequence > 0);

    await service.dispatch(firstSpec, {
      type: "detach",
      commandId: "detach-one",
      hostSessionId: firstSpec.hostSessionId,
    });
    assert.equal(
      (await service.listActivityIndex()).sessions.find(
        (entry) => entry.spec.hostSessionId === firstSpec.hostSessionId,
      )?.state,
      "busy",
      "client detach must not change target execution state",
    );

    const snapshot = await service.snapshot(firstSpec);
    await service.dispatch(firstSpec, {
      type: "resolveInteraction",
      commandId: "deny-one",
      hostSessionId: firstSpec.hostSessionId,
      runtimeEpoch: snapshot.logEpoch,
      turnId: "turn-one",
      interactionId: "approval-1",
      decision: "deny",
    });
    await service.waitForIdle(firstSpec);
    assert.equal(
      (await service.listActivityIndex()).sessions.find(
        (entry) => entry.spec.hostSessionId === firstSpec.hostSessionId,
      )?.state,
      "idle",
    );
    await service.close();

    history = new AgentHostTargetService({
      root: data,
      target: target(),
      catalog,
      registry: new HarnessRegistry(),
      authorizeWorktree: async () => false,
    });
    const recovered = await history.listActivityIndex();
    assert.equal(recovered.complete, true);
    assert.equal(
      recovered.sessions.find((entry) => entry.spec.hostSessionId === "session-one")?.state,
      "idle",
    );

    await rm(firstWorktree, { recursive: true, force: true });
    const historySnapshot = await history.snapshot(firstSpec);
    assert.ok(historySnapshot.rows.window.length > 0);
    assert.ok((await history.eventsSince(firstSpec, 0)).length > 0);
    assert.equal((await history.queryCommand(firstSpec, "send-one"))?.status, "completed");
    await assert.rejects(history.create(firstSpec));

    const indexFiles = (await readdir(data)).filter((name) => name.endsWith(".activity.json"));
    assert.equal(indexFiles.length, 2);
    const firstActivityFile = join(data, indexFiles[0]!);
    const stored = JSON.parse(await readFile(firstActivityFile, "utf8")) as { state: string };
    await writeFile(
      firstActivityFile,
      JSON.stringify({ ...stored, state: "idle", activeTurnId: "stale" }),
    );
    const afterCorruption = await history.listActivityIndex();
    assert.ok(afterCorruption.sessions.some((entry) => entry.state === "unknown"));
    await unlink(firstActivityFile);
  } finally {
    await service.close().catch(() => undefined);
    await history?.close().catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});
