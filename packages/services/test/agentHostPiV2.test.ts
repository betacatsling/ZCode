import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import type { AgentEvent, BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";

function spec(id: string, worktree: string): SessionSpecV2 {
  return {
    schemaVersion: 2,
    hostSessionId: id,
    projectId: "project",
    workspaceId: "workspace",
    execution: {
      targetId: "local",
      workspaceIdentity: "same-worktree",
      worktreePath: worktree,
      worktreeGeneration: "g1",
      cwdRelativeToWorktree: "src",
    },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "fixture", modelId: "test", options: { reasoningLevel: "off" } },
    },
  };
}
function plan(s: SessionSpecV2, fingerprint = "v1"): BindingPlan {
  return {
    schemaVersion: 1,
    hostSessionId: s.hostSessionId,
    targetId: "local",
    harnessId: "pi",
    adapterVersion: "0.87.1",
    catalogFingerprint: fingerprint,
    requested: s.modelBinding,
    effective: s.modelBinding.kind === "host-managed" ? s.modelBinding.selection : undefined,
    route: "pi-sdk",
    support: { support: "supported" },
    capabilities: {},
  };
}
function model(label: string, calls: string[]): Model {
  return {
    providerId: "fixture",
    modelId: "test",
    displayName: label,
    options: { reasoningLevel: "off" },
    properties: { contextWindow: 16000 },
    optionSpecs: { maxOutputTokens: { max: 1000 } },
    async *streamText(request: Parameters<Model["streamText"]>[0]) {
      calls.push(label);
      const last = [...request.messages]
        .reverse()
        .find((message) => message.role === "user")?.content;
      const tools = request.messages.filter((message) => message.role === "tool").length;
      yield { type: "start" };
      if (last !== "follow-up" && tools < 3) {
        // Redacted StepFun first-tool fixture: 17 reasoning deltas precede the tool even with reasoningLevel=off.
        yield { type: "reasoning_start", id: "reason" };
        for (let i = 0; i < 17; i++) yield { type: "reasoning_delta", id: "reason", text: "r" };
        yield { type: "reasoning_end", id: "reason" };
        yield { type: "text_start", id: "preface" };
        for (let i = 0; i < 7; i++) yield { type: "text_delta", id: "preface", text: "x" };
        yield { type: "text_end", id: "preface" };
        const call = [
          { id: "read-1", name: "read", input: { path: "input.txt" } },
          {
            id: "edit-1",
            name: "edit",
            input: { path: "input.txt", oldText: "before", newText: "after" },
          },
          { id: "bash-1", name: "bash", input: { command: "test -f input.txt" } },
        ][tools]!;
        yield { type: "tool_input_start", id: call.id, toolName: call.name };
        yield { type: "tool_input_delta", id: call.id, delta: JSON.stringify(call.input) };
        yield { type: "tool_input_end", id: call.id };
        yield { type: "tool_call", toolCall: call };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        };
      } else {
        yield { type: "text_start", id: "answer" };
        yield { type: "text_delta", id: "answer", text: label };
        yield { type: "text_end", id: "answer" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 3 } };
      }
    },
  } as unknown as Model;
}
async function waitFor(
  events: AgentEvent[],
  kind: AgentEvent["kind"],
  count = 1,
): Promise<AgentEvent> {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    const match = events.filter((event) => event.kind === kind);
    if (match.length >= count) return match[count - 1]!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected ${kind} (${count}); received ${events.map((event) => event.kind).join(",")}`,
  );
}

test(
  "Pi v2 captures executor per turn and isolates two native sessions sharing a subdirectory",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-v2-"));
    const tree = join(root, "tree");
    await mkdir(join(tree, "src"), { recursive: true });
    await writeFile(join(tree, "src", "input.txt"), "before");
    const calls: string[] = [];
    let revision = "initial";
    const adapter = new PiHarnessAdapter({
      root: join(root, "pi"),
      modelFactory: async () => model(revision, calls),
    });
    const a = spec("a", tree),
      b = spec("b", tree),
      pa = plan(a),
      pb = plan(b);
    try {
      const [ba, bb] = await Promise.all([adapter.create(a, pa), adapter.create(b, pb)]);
      assert.notEqual(ba.backendSessionId, bb.backendSessionId);
      assert.equal(ba.schemaVersion, 2);
      assert.equal(ba.workspaceId, "workspace");
      const ae: AgentEvent[] = [],
        be: AgentEvent[] = [];
      adapter.subscribe("a", (event) => ae.push(event));
      adapter.subscribe("b", (event) => be.push(event));
      await Promise.all([
        adapter.prepareTurn(a, { turnId: "ta", runtimeEpoch: ba.runtimeEpoch, plan: pa }),
        adapter.prepareTurn(b, { turnId: "tb", runtimeEpoch: bb.runtimeEpoch, plan: pb }),
      ]);
      await assert.rejects(
        adapter.prepareTurn(
          { ...a, execution: { ...a.execution, cwdRelativeToWorktree: "." } },
          { turnId: "wrong-cwd", runtimeEpoch: ba.runtimeEpoch, plan: pa },
        ),
        /stale or mismatched/,
      );
      revision = "catalog-changed";
      const runA = adapter.send({
        type: "send",
        commandId: "send-a",
        hostSessionId: "a",
        turnId: "ta",
        text: "read edit and test",
      });
      const runB = adapter.send({
        type: "send",
        commandId: "send-b",
        hostSessionId: "b",
        turnId: "tb",
        text: "follow-up",
      });
      const approval = await waitFor(ae, "interaction.requested");
      assert.equal(approval.kind, "interaction.requested");
      assert.equal(approval.toolCallId, "edit-1");
      assert.equal(
        be.some((e) => e.kind === "interaction.requested"),
        false,
      );
      await adapter.resolveInteraction({
        type: "resolveInteraction",
        commandId: "allow-edit",
        hostSessionId: "a",
        turnId: "ta",
        runtimeEpoch: ba.runtimeEpoch,
        interactionId: approval.interactionId,
        decision: "allow",
      });
      const bash = await waitFor(ae, "interaction.requested", 2);
      assert.equal(bash.kind, "interaction.requested");
      assert.equal(bash.toolCallId, "bash-1");
      await adapter.resolveInteraction({
        type: "resolveInteraction",
        commandId: "allow-bash",
        hostSessionId: "a",
        turnId: "ta",
        runtimeEpoch: ba.runtimeEpoch,
        interactionId: bash.interactionId,
        decision: "allow",
      });
      await Promise.all([runA, runB]);
      assert.equal(await readFile(join(tree, "src", "input.txt"), "utf8"), "after");
      assert.deepEqual(calls, ["initial", "initial", "initial", "initial", "initial"]);
      await assert.rejects(
        adapter.send({
          type: "send",
          commandId: "unprepared",
          hostSessionId: "a",
          turnId: "next",
          text: "follow-up",
        }),
        /not prepared/,
      );
      await adapter.prepareTurn(a, {
        turnId: "next",
        runtimeEpoch: ba.runtimeEpoch,
        plan: plan(a, "v2"),
      });
      await adapter.send({
        type: "send",
        commandId: "next",
        hostSessionId: "a",
        turnId: "next",
        text: "follow-up",
      });
      assert.equal(calls.at(-1), "catalog-changed");
      assert.equal(
        ae.some((e) => e.kind === "session.error"),
        false,
      );
    } finally {
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Pi v2 cancellation denies a pending write, rejects late approval and restores native history",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-v2-cancel-"));
    const tree = join(root, "tree");
    await mkdir(join(tree, "src"), { recursive: true });
    const s = spec("cancel", tree),
      p = plan(s);
    const calls: string[] = [];
    const deniedModel = {
      ...model("restored", calls),
      async *streamText(request: Parameters<Model["streamText"]>[0]) {
        calls.push("requested");
        yield { type: "start" };
        if (request.messages.some((m) => m.role === "tool")) {
          yield { type: "text_start", id: "answer" };
          yield { type: "text_delta", id: "answer", text: "denied" };
          yield { type: "text_end", id: "answer" };
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          yield { type: "tool_input_start", id: "write", toolName: "write" };
          yield {
            type: "tool_input_delta",
            id: "write",
            delta: '{"path":"no.txt","content":"unsafe"}',
          };
          yield { type: "tool_input_end", id: "write" };
          yield {
            type: "tool_call",
            toolCall: { id: "write", name: "write", input: { path: "no.txt", content: "unsafe" } },
          };
          yield {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
      },
    } as Model;
    const adapter = new PiHarnessAdapter({
      root: join(root, "pi"),
      modelFactory: () => deniedModel,
    });
    let restored: PiHarnessAdapter | undefined;
    try {
      const binding = await adapter.create(s, p);
      const events: AgentEvent[] = [];
      adapter.subscribe(s.hostSessionId, (event) => events.push(event));
      await adapter.prepareTurn(s, { turnId: "turn", runtimeEpoch: binding.runtimeEpoch, plan: p });
      const running = adapter.send({
        type: "send",
        commandId: "send",
        hostSessionId: s.hostSessionId,
        turnId: "turn",
        text: "write",
      });
      const interaction = await waitFor(events, "interaction.requested");
      assert.equal(interaction.kind, "interaction.requested");
      await assert.rejects(readFile(join(tree, "src", "no.txt")), { code: "ENOENT" });
      await adapter.cancelTurn({
        type: "cancelTurn",
        commandId: "cancel",
        hostSessionId: s.hostSessionId,
        turnId: "turn",
      });
      await assert.rejects(
        adapter.resolveInteraction({
          type: "resolveInteraction",
          commandId: "late",
          hostSessionId: s.hostSessionId,
          runtimeEpoch: binding.runtimeEpoch,
          turnId: "turn",
          interactionId: interaction.interactionId,
          decision: "allow",
        }),
        /failed/,
      );
      await running;
      assert.equal(
        events.some((e) => e.kind === "turn.finished" && e.outcome === "cancelled"),
        true,
      );
      await assert.rejects(readFile(join(tree, "src", "no.txt")), { code: "ENOENT" });
      const sequence = events.at(-1)?.sequence ?? 0;
      await adapter.shutdown();
      restored = new PiHarnessAdapter({ root: join(root, "pi"), modelFactory: () => deniedModel });
      await restored.attach(s, binding, sequence, p);
      const after: AgentEvent[] = [];
      restored.subscribe(s.hostSessionId, (event) => after.push(event));
      await restored.prepareTurn(s, {
        turnId: "after",
        runtimeEpoch: binding.runtimeEpoch,
        plan: p,
      });
      await restored.send({
        type: "send",
        commandId: "follow",
        hostSessionId: s.hostSessionId,
        turnId: "after",
        text: "follow-up",
      });
      assert.equal(
        after.some((e) => e.kind === "interaction.requested"),
        false,
      );
      assert.equal(calls.length > 1, true);
      assert.equal(
        after.some(
          (e) => e.kind === "message.finished" && e.role === "assistant" && e.text === "denied",
        ),
        true,
      );
      await assert.rejects(readFile(join(tree, "src", "no.txt")), { code: "ENOENT" });
    } finally {
      await Promise.all([adapter.shutdown(), restored?.shutdown()]);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "Pi worker shutdown with a pending approval rejects the accepted send without replaying a write",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-v2-worker-stop-"));
    const tree = join(root, "tree");
    await mkdir(join(tree, "src"), { recursive: true });
    const s = spec("stopped", tree),
      p = plan(s);
    const failing = {
      ...model("stopped", []),
      async *streamText() {
        yield { type: "start" };
        yield { type: "tool_input_start", id: "write", toolName: "write" };
        yield {
          type: "tool_input_delta",
          id: "write",
          delta: '{"path":"no.txt","content":"unsafe"}',
        };
        yield { type: "tool_input_end", id: "write" };
        yield {
          type: "tool_call",
          toolCall: { id: "write", name: "write", input: { path: "no.txt", content: "unsafe" } },
        };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as Model;
    const adapter = new PiHarnessAdapter({ root: join(root, "pi"), modelFactory: () => failing });
    try {
      const binding = await adapter.create(s, p);
      const events: AgentEvent[] = [];
      adapter.subscribe(s.hostSessionId, (event) => events.push(event));
      await adapter.prepareTurn(s, { turnId: "turn", runtimeEpoch: binding.runtimeEpoch, plan: p });
      const running = adapter.send({
        type: "send",
        commandId: "send",
        hostSessionId: s.hostSessionId,
        turnId: "turn",
        text: "write",
      });
      const rejected = assert.rejects(running, /shut down/);
      await waitFor(events, "interaction.requested");
      await adapter.shutdown();
      await rejected;
      await assert.rejects(readFile(join(tree, "src", "no.txt")), { code: "ENOENT" });
      // Host retains accepted/unknown ownership; a new adapter must not invent a successful completion.
      assert.equal(
        events.some((event) => event.kind === "turn.finished"),
        false,
      );
    } finally {
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("Pi v2 refuses a symlink cwd escaping its worktree before launching a worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-v2-escape-"));
  const tree = join(root, "tree");
  await mkdir(tree);
  await symlink(root, join(tree, "src"));
  const adapter = new PiHarnessAdapter({
    root: join(root, "pi"),
    modelFactory: () => model("safe", []),
  });
  try {
    await assert.rejects(
      adapter.create(spec("escape", tree), plan(spec("escape", tree))),
      /escapes target worktree/,
    );
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
