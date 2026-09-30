/**
 * The typed refusals of AgentHostTargetService reach an RPC client as name + code (the class does
 * not cross): the service goes through createRpcAgentHostService → ProxyChannel → ChannelServer /
 * ChannelClient over an in-memory protocol pair, the same stack the Host websocket uses.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelClient, ChannelServer, Event, ProxyChannel, createQueuePair } from "@zcode/rpc";
import type { AgentCommand, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { createRpcAgentHostService } from "../src/agent-host/rpcTargetService.js";
import type { IAgentHostService } from "../src/agent-host/serviceContract.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const TARGET_ID = "target-rpc";

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

function makeService(root: string, harness: MockHarness): AgentHostTargetService {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return new AgentHostTargetService({
    root,
    target: target(),
    catalog: { fingerprint: "rpc-error-code", validateSelection: () => ({ ok: true as const }) },
    registry,
    authorizeWorktree: async () => true,
  });
}

function send(spec: SessionSpec): AgentCommand {
  return {
    type: "send",
    commandId: "send-rpc",
    hostSessionId: spec.hostSessionId,
    turnId: "turn-rpc",
    text: "x",
  };
}

function detach(spec: SessionSpec): AgentCommand {
  return { type: "detach", commandId: "detach-rpc", hostSessionId: spec.hostSessionId };
}

async function overRpc(
  service: AgentHostTargetService,
  run: (remote: IAgentHostService) => Promise<void>,
): Promise<void> {
  const exposed = createRpcAgentHostService(service, () => true);
  const [clientSide, serverSide] = createQueuePair();
  const server = new ChannelServer(serverSide, "ctx");
  server.registerChannel("agentHost", ProxyChannel.fromService(exposed.service));
  const client = new ChannelClient(clientSide);
  try {
    await Event.toPromise(client.onDidInitialize);
    await run(ProxyChannel.toService<IAgentHostService>(client.getChannel("agentHost")));
  } finally {
    client.dispose();
    server.dispose();
    exposed.dispose();
  }
}

function wireError(name: string, code: string, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof Error, String(error));
    assert.equal(error.name, name);
    assert.equal((error as Error & { code?: unknown }).code, code);
    assert.match(error.message, message);
    return true;
  };
}

async function withTemp(run: (root: string, worktree: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "zcode-rpc-error-code-"));
  const worktree = join(temp, "worktree");
  await mkdir(worktree);
  try {
    await run(join(temp, "host"), worktree);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

test("a closed target's refusals arrive over RPC as SessionHostClosedError / host-closed", async () => {
  await withTemp(async (root, worktree) => {
    const spec = session("host-closed-rpc", worktree);
    const service = makeService(root, new MockHarness());
    await service.create(spec);
    await service.close();
    await overRpc(service, async (remote) => {
      const closed = wireError("SessionHostClosedError", "host-closed", /^target host is closing/);
      await assert.rejects(remote.dispatch(spec, send(spec)), closed);
      await assert.rejects(remote.create(session("host-fresh-rpc", worktree)), closed);
      await assert.rejects(remote.attach(spec), closed);
      // History reads still answer over the same channel.
      assert.ok((await remote.snapshot(spec)).seq >= 0);
    });
  });
});

test("an unmounted session's refusal arrives over RPC as SessionNotAttachedError / not-attached", async () => {
  await withTemp(async (root, worktree) => {
    const spec = session("host-unmounted-rpc", worktree);
    const harness = new MockHarness();
    const first = makeService(root, harness);
    await first.create(spec);
    await first.close();
    const next = makeService(root, harness);
    try {
      await overRpc(next, async (remote) => {
        await assert.rejects(
          remote.dispatch(spec, detach(spec)),
          wireError("SessionNotAttachedError", "not-attached", /^external session is not attached/),
        );
      });
    } finally {
      await next.close();
    }
  });
});
