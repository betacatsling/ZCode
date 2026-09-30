/**
 * Typed refusals from AgentHostTargetService.
 *
 * - Closing/closed target owner: every call that needs a live host (create, attach, dispatch,
 *   waitForIdle) rejects with SessionHostClosedError, code "host-closed", message still starting
 *   "target host is closing". History reads (snapshot, queryCommand, listActivityIndex, ...) keep
 *   working from disk after close; they never needed a live host.
 * - Open target, session not mounted here (never attached, a failed attach, or another owner holds
 *   it): dispatch / waitForIdle reject with SessionNotAttachedError, code "not-attached", message
 *   still starting "external session is not attached". Distinct from host-closed: the target is
 *   healthy and attaching (or asking the owner that holds it) is the remedy.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentCommand, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { SessionHostClosedError } from "../src/agent-host/sessionHost.js";
import { SessionNotAttachedError } from "../src/agent-host/targetErrors.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const TARGET_ID = "target-a";
const catalog = { fingerprint: "typed-refusals", validateSelection: () => ({ ok: true as const }) };

function target(): ExecutionTarget {
  return {
    id: TARGET_ID,
    kind: "local",
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
}

function session(hostSessionId: string, worktreePath: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: { targetId: TARGET_ID, workspaceIdentity: "workspace-a", worktreePath },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
}

function makeService(root: string, harness = new MockHarness()): AgentHostTargetService {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return new AgentHostTargetService({
    root,
    target: target(),
    catalog,
    registry,
    authorizeWorktree: async () => true,
  });
}

function send(spec: SessionSpec, id: string): AgentCommand {
  return {
    type: "send",
    commandId: `send-${id}`,
    hostSessionId: spec.hostSessionId,
    turnId: `turn-${id}`,
    text: "x",
  };
}

function detach(spec: SessionSpec, id: string): AgentCommand {
  return { type: "detach", commandId: `detach-${id}`, hostSessionId: spec.hostSessionId };
}

/** name + code are what survives an RPC hop, so assert them, not only instanceof. */
function hostClosed(label: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SessionHostClosedError, `${label}: ${String(error)}`);
    assert.equal(error.name, "SessionHostClosedError");
    assert.equal(error.code, "host-closed");
    assert.match(error.message, /^target host is closing/, label);
    return true;
  };
}

function notAttached(label: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SessionNotAttachedError, `${label}: ${String(error)}`);
    assert.equal(error.name, "SessionNotAttachedError");
    assert.equal(error.code, "not-attached");
    assert.match(error.message, /^external session is not attached/, label);
    return true;
  };
}

async function withTemp(run: (root: string, worktree: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "zcode-target-typed-"));
  const worktree = join(temp, "worktree");
  await mkdir(worktree);
  try {
    await run(join(temp, "host"), worktree);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("a closed target refuses every live-host call with SessionHostClosedError (host-closed)", async () => {
  await withTemp(async (root, worktree) => {
    const mounted = session("host-mounted", worktree);
    const fresh = session("host-fresh", worktree);
    const service = makeService(root);
    await service.create(mounted);
    await service.close();

    await assert.rejects(service.dispatch(mounted, send(mounted, "1")), hostClosed("send"));
    await assert.rejects(service.dispatch(mounted, detach(mounted, "1")), hostClosed("detach"));
    await assert.rejects(service.create(fresh), hostClosed("create"));
    await assert.rejects(service.attach(mounted), hostClosed("attach"));
    await assert.rejects(service.waitForIdle(mounted), hostClosed("waitForIdle"));

    // History stays readable from disk after close.
    assert.ok((await service.snapshot(mounted)).seq >= 0);
    assert.deepEqual(
      (await service.listActivityIndex()).sessions.map((entry) => entry.spec.hostSessionId),
      ["host-mounted"],
    );
  });
});

test("an open target refuses a session it has not mounted with SessionNotAttachedError (not-attached)", async () => {
  await withTemp(async (root, worktree) => {
    const spec = session("host-a", worktree);
    // One harness process outlives both owners, so the second one can attach.
    const harness = new MockHarness();
    const first = makeService(root, harness);
    await first.create(spec);
    await first.close();

    const next = makeService(root, harness);
    try {
      await assert.rejects(next.dispatch(spec, detach(spec, "2")), notAttached("detach"));
      await assert.rejects(next.waitForIdle(spec), notAttached("waitForIdle"));
      // Attaching is the remedy: afterwards the same calls work.
      await next.attach(spec);
      await next.waitForIdle(spec);
      assert.equal((await next.dispatch(spec, detach(spec, "3"))).status, "completed");
    } finally {
      await next.close();
    }
  });
});
