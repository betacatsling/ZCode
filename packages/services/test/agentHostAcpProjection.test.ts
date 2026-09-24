import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  AcpHarnessAdapter,
  type TrustedAcpProfile,
} from "../src/agent-adapters/acp/acpHarnessAdapter.js";
import type { AcpProcess } from "../src/agent-adapters/acp/acpTransport.js";
import type { AgentEvent, BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";

function agent() {
  const stdin = new PassThrough(),
    stdout = new PassThrough();
  const process = Object.assign(new EventEmitter(), {
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
  stdin.on("data", (data: Buffer) => {
    for (const line of data.toString().trim().split("\n"))
      frames.push(JSON.parse(line) as Record<string, unknown>);
  });
  const send = (data: Record<string, unknown>) =>
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...data })}\n`);
  const answer = async (method: string, result: unknown) => {
    await new Promise((resolve) => setImmediate(resolve));
    const frame = frames.findLast((item) => item.method === method);
    assert.ok(frame, method);
    send({ id: frame.id, result });
  };
  return { process, frames, send, answer };
}
const target = {
  id: "target",
  kind: "local" as const,
  platform: "darwin" as const,
  available: true,
};
function session(id: string): SessionSpecV2 {
  return {
    schemaVersion: 2,
    hostSessionId: id,
    projectId: "p",
    workspaceId: "w",
    execution: {
      targetId: "target",
      workspaceIdentity: "identity",
      worktreePath: "/safe",
      worktreeGeneration: "gen",
      cwdRelativeToWorktree: ".",
    },
    harness: { id: "acp-alpha", adapterVersion: "0.16.2" },
    modelBinding: { kind: "harness-managed" },
  };
}
function binding(spec: SessionSpecV2): BindingPlan {
  return {
    schemaVersion: 1,
    hostSessionId: spec.hostSessionId,
    targetId: "target",
    harnessId: "acp-alpha",
    adapterVersion: "0.16.2",
    catalogFingerprint: "pin",
    requested: spec.modelBinding,
    route: "harness-managed",
    support: { support: "supported" },
    capabilities: {},
  };
}
test("same harness independent processes; structured text/tool/usage/status; terminate does not overkill", async () => {
  const first = agent(),
    second = agent();
  const processes = [first, second];
  const profile: TrustedAcpProfile = {
    id: "acp-alpha",
    version: "0.16.2",
    certified: true,
    verifyCwd: async () => "/safe",
    targetFor: () => target,
    probeDescriptor: () => ({
      executable: "/trusted/agent",
      argv: [],
      cwd: "/safe",
      env: { HOME: "/trusted/profile" },
      version: { argv: [], exact: "0.16.2" },
    }),
    descriptor: (_target, cwd, id) => ({
      executable: "/trusted/agent",
      argv: [id],
      cwd,
      env: { HOME: `/trusted/${id}` },
      version: { argv: [], exact: "0.16.2" },
    }),
    transport: {
      probeVersion: async () => "0.16.2",
      launch: () => {
        const next = processes.shift();
        assert.ok(next);
        return next.process;
      },
    },
  };
  const adapter = new AcpHarnessAdapter(profile);
  for (const [id, fixture] of [
    ["one", first],
    ["two", second],
  ] as const) {
    const creating = adapter.create(session(id), binding(session(id)));
    await fixture.answer("initialize", { protocolVersion: 1, agentCapabilities: {} });
    await fixture.answer("session/new", { sessionId: `native-${id}` });
    await creating;
  }
  const events: AgentEvent[] = [];
  adapter.subscribe("two", (event) => events.push(event));
  const send = adapter.send({
    type: "send",
    hostSessionId: "two",
    commandId: "cmd",
    turnId: "turn",
    text: "hi",
  });
  const update = (value: Record<string, unknown>) =>
    second.send({ method: "session/update", params: { sessionId: "native-two", update: value } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } });
  update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "Read", status: "pending" });
  update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" });
  update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" });
  update({ sessionUpdate: "usage_update", inputTokens: 3, outputTokens: 2 });
  await second.answer("session/prompt", { stopReason: "end_turn" });
  await send;
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "turn.started",
      "session.status",
      "text.delta",
      "tool.started",
      "tool.finished",
      "usage.reported",
      "message.finished",
      "turn.finished",
      "session.status",
    ],
  );
  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.ok(events.some((event) => event.kind === "message.finished" && event.text === "hello"));
  await adapter.terminate("one");
  assert.equal(first.process.killed, true);
  assert.equal(second.process.killed, false);
  await adapter.shutdown();
});
