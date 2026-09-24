import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

function scriptedModel(): Model {
  return {
    providerId: "test-provider", modelId: "test-model", displayName: "Scripted fixture",
    properties: { contextWindow: 32000 }, optionSpecs: { maxOutputTokens: { max: 1000 } }, options: { reasoningLevel: "off" },
    async *streamText(request: Parameters<Model["streamText"]>[0]) {
      const toolResults = request.messages.filter((message) => message.role === "tool").length;
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const followUp = lastUser?.content === "Follow up";
      yield { type: "start", modelId: "test-model" };
      if (!followUp && toolResults < 3) {
        const calls = [
          { id: "read-1", name: "read", input: { path: "input.txt" } },
          { id: "write-1", name: "write", input: { path: "output.txt", content: "fixture written" } },
          { id: "bash-1", name: "bash", input: { command: "test -f output.txt" } },
        ];
        const call = calls[toolResults]!;
        yield { type: "tool_input_start", id: call.id, toolName: call.name };
        yield { type: "tool_input_delta", id: call.id, delta: JSON.stringify(call.input) };
        yield { type: "tool_input_end", id: call.id };
        yield { type: "tool_call", toolCall: call };
        yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 9, outputTokens: 5 } };
      } else {
        yield { type: "text_start", id: "reply" };
        yield { type: "text_delta", id: "reply", text: followUp ? "File is still present" : "Read, wrote and tested" };
        yield { type: "text_end", id: "reply" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 5 } };
      }
    },
  } as unknown as Model;
}

test("Pi SDK with fake ZCode executor reads, writes, tests and follows up over two turns", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-loop-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  await writeFile(join(worktree, "input.txt"), "fixture input");
  const registry = new HarnessRegistry();
  registry.register(new PiHarnessAdapter({ root: join(root, "workers"), modelFactory: () => scriptedModel() }));
  const spec = {
    schemaVersion: 1 as const, hostSessionId: "pi-loop", execution: { targetId: "local", workspaceIdentity: "fixture-loop", worktreePath: worktree },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding: { kind: "host-managed" as const, selection: { providerId: "test-provider", modelId: "test-model", options: { reasoningLevel: "off" } } },
  };
  const target = { id: "local", kind: "local" as const, platform: process.platform as "darwin" | "linux", available: true };
  let host: SessionHost | undefined;
  try {
    host = await SessionHost.create({ root: join(root, "journals"), spec, target, registry, catalog: { fingerprint: "fixture-v1", validateSelection: () => ({ ok: true }) } });
    const approvals: string[] = [];
    const requested = new Set<string>();
    host.subscribe((event) => { if (event.kind === "interaction.requested") { approvals.push(event.interactionId); requested.add(event.interactionId); } });
    await host.dispatch({ type: "send", commandId: "first", hostSessionId: "pi-loop", turnId: "first-turn", text: "Read input, write output, run test" });
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 8000;
      while (approvals.length < count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(approvals.length, count, `Expected ${count} approvals, got ${approvals.length}; events: ${host!.eventsSince(0).map((e) => e.kind)}`);
    };
    await waitFor(1);
    assert.equal(approvals[0], "write-1");
    await host.dispatch({ type: "resolveInteraction", commandId: "allow-write", hostSessionId: "pi-loop", runtimeEpoch: host.binding.runtimeEpoch, turnId: "first-turn", interactionId: approvals[0]!, decision: "allow" });
    await waitFor(2);
    assert.equal(approvals[1], "bash-1");
    await host.dispatch({ type: "resolveInteraction", commandId: "allow-bash", hostSessionId: "pi-loop", runtimeEpoch: host.binding.runtimeEpoch, turnId: "first-turn", interactionId: approvals[1]!, decision: "allow" });
    await host.whenIdle();
    assert.equal(await readFile(join(worktree, "output.txt"), "utf8"), "fixture written");
    assert.equal(requested.size, 2);
    assert.equal(host.snapshot().rows.window.some((row) => row.kind === "assistantText" && row.text === "Read, wrote and tested"), true);
    await host.dispatch({ type: "send", commandId: "follow-up", hostSessionId: "pi-loop", turnId: "second-turn", text: "Follow up" });
    await host.whenIdle();
    assert.equal(host.snapshot().rows.window.some((row) => row.kind === "assistantText" && row.text === "File is still present"), true);
    await host.dispatch({ type: "terminateSession", commandId: "terminate", hostSessionId: "pi-loop" });
    await host.close();
    host = undefined;
  } finally {
    if (host) {
      try { await host.dispatch({ type: "terminateSession", commandId: "cleanup", hostSessionId: "pi-loop" }); await host.close(); } catch { /* isolated fixture */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
