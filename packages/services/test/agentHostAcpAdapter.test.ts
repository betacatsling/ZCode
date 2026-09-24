import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AcpHarnessAdapter,
  type TrustedAcpProfile,
} from "../src/agent-adapters/acp/acpHarnessAdapter.js";
import type { AcpProcess } from "../src/agent-adapters/acp/acpTransport.js";
import { createTrustedAcpFactory } from "../src/agent-adapters/acp/acpFactory.js";
import { HarnessRegistry, type HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import type { AgentEvent, BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";

const target = {
  id: "target",
  available: true,
  kind: "local" as const,
  platform: "darwin" as const,
};
function spec(id: string, harness = "acp-alpha"): SessionSpecV2 {
  return {
    schemaVersion: 2,
    hostSessionId: id,
    projectId: "p",
    workspaceId: "w",
    execution: {
      targetId: "target",
      workspaceIdentity: "identity",
      worktreePath: "/verified/work",
      worktreeGeneration: "gen",
      cwdRelativeToWorktree: ".",
    },
    harness: { id: harness, adapterVersion: "0.16.2" },
    modelBinding: { kind: "harness-managed" },
  };
}
function plan(s: SessionSpecV2): BindingPlan {
  return {
    schemaVersion: 1,
    hostSessionId: s.hostSessionId,
    targetId: s.execution.targetId,
    harnessId: s.harness.id,
    adapterVersion: s.harness.adapterVersion,
    catalogFingerprint: "pin",
    requested: s.modelBinding,
    route: "harness-managed",
    support: { support: "supported" },
    capabilities: {},
  };
}
function fake(load: boolean) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true;
      this.emit("exit", 0);
      return true;
    },
  }) as AcpProcess & { killed: boolean };
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      frames.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
    }
  });
  const receive = (frame: unknown) =>
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
  const answer = async (method: string, result: unknown) => {
    await new Promise((resolve) => setImmediate(resolve));
    const request = frames.findLast((f) => f.method === method);
    assert.ok(request, `missing ${method}`);
    receive({ id: request.id, result });
  };
  return { child, frames, receive, answer, load };
}
function profile(
  harness: string,
  processes: ReturnType<typeof fake>[],
  verified = "/verified/work",
): TrustedAcpProfile {
  return {
    id: harness,
    version: "0.16.2",
    certified: true,
    verifyCwd: async () => verified,
    targetFor: () => target,
    probeDescriptor: () => ({
      executable: "/trusted/agent",
      argv: [],
      cwd: "/trusted/probe",
      env: { HOME: "/trusted/home" },
      version: { argv: ["--version"], exact: "0.16.2" },
    }),
    descriptor: (_target, cwd, id) => ({
      executable: "/trusted/agent",
      argv: [id],
      cwd,
      env: { HOME: `/trusted/profiles/${id}` },
      version: { argv: ["--version"], exact: "0.16.2" },
    }),
    transport: {
      probeVersion: async () => "0.16.2",
      launch: () => {
        const next = processes.shift();
        assert.ok(next, "unexpected process");
        return next.child;
      },
    },
  };
}
async function start(adapter: HarnessAdapter, f: ReturnType<typeof fake>, s: SessionSpecV2) {
  const creating = adapter.create(s, plan(s));
  await f.answer("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: f.load } });
  await f.answer("session/new", { sessionId: `native-${s.hostSessionId}` });
  return creating;
}
test("two manifest-only profiles, independent sessions, pre-tool denial and stale approval after cancel", async () => {
  const a = fake(true),
    b = fake(false);
  const registry = new HarnessRegistry();
  for (const [id, fixture] of [
    ["acp-alpha", a],
    ["acp-beta", b],
  ] as const) {
    const manifest = { schemaVersion: 1 as const, id, name: id, adapterVersion: "0.16.2" };
    registry.registerTrusted(manifest, createTrustedAcpFactory(manifest, profile(id, [fixture])));
  }
  const alpha = registry.require("acp-alpha");
  const beta = registry.require("acp-beta");
  assert.deepEqual(
    registry.manifests().map((item) => item.id),
    ["acp-alpha", "acp-beta"],
  );
  assert.throws(
    () =>
      createTrustedAcpFactory(
        { schemaVersion: 1, id: "acp-third", name: "third", adapterVersion: "0.16.2" },
        profile("acp-alpha", []),
      ),
    /identity/,
  );
  assert.equal((await alpha.probe(target)).support, "supported");
  const unverified = profile("acp-unverified", []);
  unverified.certified = false;
  assert.equal((await new AcpHarnessAdapter(unverified).probe(target)).support, "experimental");
  assert.equal((await alpha.hostManagedSupport(target, {} as never)).support, "unsupported");
  const sa = spec("one"),
    sb = spec("two", "acp-beta");
  const ba = await start(alpha, a, sa),
    bb = await start(beta, b, sb);
  const events: AgentEvent[] = [];
  alpha.subscribe("one", (event) => events.push(event));
  const sending = alpha.send({
    type: "send",
    hostSessionId: "one",
    turnId: "turn",
    commandId: "send",
    text: "work",
  });
  a.receive({
    method: "session/update",
    params: {
      sessionId: ba.backendSessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    },
  });
  a.receive({
    method: "session/update",
    params: {
      sessionId: ba.backendSessionId,
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "reason" } },
    },
  });
  a.receive({
    method: "session/update",
    params: {
      sessionId: ba.backendSessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "Edit", status: "pending" },
    },
  });
  a.receive({
    id: 40,
    method: "session/request_permission",
    params: {
      sessionId: ba.backendSessionId,
      toolCall: { toolCallId: "tool", title: "Edit" },
      options: [{ optionId: "yes", kind: "allow_once" }],
    },
  });
  assert.equal(
    a.frames.some((f) => f.id === 40 && "result" in f),
    false,
  );
  assert.ok(events.some((e) => e.kind === "interaction.requested"));
  await assert.rejects(
    alpha.resolveInteraction({
      type: "resolveInteraction",
      hostSessionId: "one",
      commandId: "bad",
      turnId: "turn",
      runtimeEpoch: "old",
      interactionId: "40",
      decision: "allow",
    }),
    /stale/,
  );
  await alpha.resolveInteraction({
    type: "resolveInteraction",
    hostSessionId: "one",
    commandId: "deny",
    turnId: "turn",
    runtimeEpoch: ba.runtimeEpoch,
    interactionId: "40",
    decision: "deny",
  });
  assert.deepEqual(a.frames.find((f) => f.id === 40 && "result" in f)?.result, {
    outcome: { outcome: "cancelled" },
  });
  a.receive({
    id: 41,
    method: "session/request_permission",
    params: {
      sessionId: ba.backendSessionId,
      toolCall: { toolCallId: "tool2" },
      options: [{ optionId: "yes", kind: "allow_once" }],
    },
  });
  await alpha.cancelTurn({
    type: "cancelTurn",
    hostSessionId: "one",
    commandId: "cancel",
    turnId: "turn",
    runtimeEpoch: ba.runtimeEpoch,
  });
  assert.equal(
    a.frames.some((f) => f.id === 41 && objectResult(f)),
    true,
  );
  await assert.rejects(
    alpha.resolveInteraction({
      type: "resolveInteraction",
      hostSessionId: "one",
      commandId: "late",
      turnId: "turn",
      runtimeEpoch: ba.runtimeEpoch,
      interactionId: "41",
      decision: "allow",
    }),
    /stale/,
  );
  const prompt = a.frames.find((f) => f.method === "session/prompt");
  assert.ok(prompt);
  a.receive({ id: prompt.id, result: { stopReason: "cancelled" } });
  await sending;
  assert.ok(events.some((e) => e.kind === "turn.finished" && e.outcome === "cancelled"));
  assert.ok(events.some((e) => e.kind === "extension.event" && e.namespace === "acp.reasoning"));
  await alpha.terminate("one");
  assert.equal(a.child.killed, true);
  assert.equal(b.child.killed, false);
  assert.equal(bb.backendSessionId, "native-two");
  await beta.shutdown();
});
test("unknown native stop persists uncertain Host receipt and blocks next admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-unknown-host-"));
  const f = fake(true);
  const registry = new HarnessRegistry();
  const p = profile("acp-alpha", [f]);
  registry.registerTrusted(
    { schemaVersion: 1, id: p.id, name: p.id, adapterVersion: p.version },
    createTrustedAcpFactory(
      { schemaVersion: 1, id: p.id, name: p.id, adapterVersion: p.version },
      p,
    ),
  );
  const s = spec("unknown-host");
  let host: SessionHost | undefined;
  try {
    const creating = SessionHost.create({
      root,
      spec: s,
      target,
      registry,
      catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
    });
    for (let i = 0; !f.frames.some((frame) => frame.method === "initialize") && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await f.answer("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    await f.answer("session/new", { sessionId: "native-unknown" });
    host = await creating;
    assert.equal(
      (
        await host.dispatch({
          type: "send",
          commandId: "first",
          hostSessionId: s.hostSessionId,
          turnId: "t1",
          text: "work",
        })
      ).status,
      "accepted",
    );
    await f.answer("session/prompt", { stopReason: "future_value" });
    await host.whenIdleAllowingGap();
    assert.equal(host.queryCommand("first")?.status, "execution-unknown");
    assert.equal(host.getActivity(), "uncertain");
    assert.equal(
      (
        await host.dispatch({
          type: "send",
          commandId: "second",
          hostSessionId: s.hostSessionId,
          turnId: "t2",
          text: "no",
        })
      ).status,
      "rejected",
    );
    assert.equal(f.frames.filter((frame) => frame.method === "session/prompt").length, 1);
    assert.equal(
      (await SessionHost.queryCommandHistory(root, s, "first"))?.status,
      "execution-unknown",
    );
  } finally {
    if (host) {
      await registry.require(p.id).shutdown?.();
      await host.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("cancel followed by native error never completes as cancelled or admits another turn", async () => {
  const f = fake(true);
  const adapter = new AcpHarnessAdapter(profile("acp-alpha", [f]));
  const s = spec("cancel-error");
  const binding = await start(adapter, f, s);
  const events: AgentEvent[] = [];
  adapter.subscribe(s.hostSessionId, (event) => events.push(event));
  const command = {
    type: "send" as const,
    hostSessionId: s.hostSessionId,
    commandId: "first",
    turnId: "t1",
    text: "work",
  };
  const sending = adapter.send(command);
  await adapter.cancelTurn({
    type: "cancelTurn",
    hostSessionId: s.hostSessionId,
    commandId: "cancel",
    turnId: "t1",
    runtimeEpoch: binding.runtimeEpoch,
  });
  const prompt = f.frames.find((frame) => frame.method === "session/prompt");
  assert.ok(prompt);
  f.receive({ id: prompt.id, error: { code: -32000, message: "still running" } });
  await assert.rejects(sending, /outcome unknown/);
  assert.equal(
    events.some((e) => e.kind === "turn.finished" && e.outcome === "cancelled"),
    false,
  );
  await assert.rejects(
    adapter.send({ ...command, commandId: "second", turnId: "t2" }),
    /busy or execution unknown/,
  );
  assert.equal(f.frames.filter((frame) => frame.method === "session/prompt").length, 1);
  await adapter.shutdown();
});

test("unknown native stop fences adapter without a success event or second prompt", async () => {
  const f = fake(true);
  const adapter = new AcpHarnessAdapter(profile("acp-alpha", [f]));
  const s = spec("uncertain");
  await start(adapter, f, s);
  const events: AgentEvent[] = [];
  adapter.subscribe(s.hostSessionId, (event) => events.push(event));
  const command = {
    type: "send" as const,
    hostSessionId: s.hostSessionId,
    commandId: "first",
    turnId: "t1",
    text: "work",
  };
  const sending = adapter.send(command);
  await f.answer("session/prompt", { stopReason: "future_value" });
  await assert.rejects(sending, /outcome unknown/);
  assert.equal(
    events.some((e) => e.kind === "turn.finished"),
    false,
  );
  assert.ok(events.some((e) => e.kind === "session.status" && e.state === "execution-unknown"));
  await assert.rejects(
    adapter.send({ ...command, commandId: "second", turnId: "t2" }),
    /busy or execution unknown/,
  );
  assert.equal(f.frames.filter((frame) => frame.method === "session/prompt").length, 1);
  await adapter.shutdown();
});

function objectResult(frame: Record<string, unknown>) {
  return "result" in frame;
}
test("native load only when negotiated; history-only and mismatched cwd fail closed", async () => {
  const original = fake(true),
    resumed = fake(true),
    history = fake(false);
  const s = spec("resume");
  const owner = new AcpHarnessAdapter(profile("acp-alpha", [original]));
  const binding = await start(owner, original, s);
  await owner.shutdown();
  const loading = new AcpHarnessAdapter(profile("acp-alpha", [resumed]));
  const attach = loading.attach(s, binding, 3, plan(s));
  await resumed.answer("initialize", {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  });
  await resumed.answer("session/load", {});
  await attach;
  const loadRequest = resumed.frames.find((f) => f.method === "session/load");
  assert.ok(loadRequest);
  assert.equal((loadRequest.params as { sessionId: string }).sessionId, binding.backendSessionId);
  await loading.shutdown();
  const noLoad = new AcpHarnessAdapter(profile("acp-alpha", [history]));
  const rejected = noLoad.attach(s, binding, 3, plan(s));
  await history.answer("initialize", { protocolVersion: 1, agentCapabilities: {} });
  await assert.rejects(rejected, /history-only/);
  assert.equal(
    history.frames.some((f) => f.method === "session/new" || f.method === "session/load"),
    false,
  );
  const wrongProfile = profile("acp-alpha", []);
  wrongProfile.descriptor = (t, cwd, id) => ({
    ...profile("acp-alpha", []).descriptor(t, cwd, id),
    cwd: "/wrong",
  });
  const wrong = new AcpHarnessAdapter(wrongProfile);
  await assert.rejects(wrong.create(s, plan(s)), /descriptor cwd/);
});
