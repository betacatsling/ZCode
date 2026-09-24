import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

function scriptedModel(): Model {
  return {
    providerId: "test-provider",
    modelId: "test-model",
    displayName: "Scripted fixture",
    properties: { contextWindow: 32000 },
    optionSpecs: { maxOutputTokens: { max: 1000 } },
    options: { reasoningLevel: "off" },
    async *streamText(request: Parameters<Model["streamText"]>[0]) {
      if (JSON.stringify(request.messages).includes("SECRET_OUTSIDE"))
        throw new Error("default SDK read escaped the mounted file boundary");
      const toolResults = request.messages.filter((message) => message.role === "tool").length;
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const followUp = lastUser?.content === "Follow up";
      yield { type: "start", modelId: "test-model" };
      const calls = followUp
        ? [{ id: "read-later", name: "read", input: { path: "output.txt" } }]
        : [
            { id: "read-1", name: "read", input: { path: "input.txt" } },
            { id: "write-denied", name: "write", input: { path: "output.txt", content: "denied" } },
            {
              id: "write-1",
              name: "write",
              input: { path: "output.txt", content: "fixture written" },
            },
            {
              id: "edit-1",
              name: "edit",
              input: { path: "output.txt", edits: [{ oldText: "written", newText: "edited" }] },
            },
            { id: "bash-1", name: "bash", input: { command: "test -f output.txt" } },
          ];
      const index = followUp ? toolResults - 5 : toolResults;
      if (index < calls.length) {
        const call = calls[index]!;
        yield { type: "tool_input_start", id: call.id, toolName: call.name };
        yield { type: "tool_input_delta", id: call.id, delta: JSON.stringify(call.input) };
        yield { type: "tool_input_end", id: call.id };
        yield { type: "tool_call", toolCall: call };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 9, outputTokens: 5 },
        };
      } else {
        // The later turn must observe the edited file content via the mounted native read.
        if (followUp && !JSON.stringify(request.messages).includes("fixture edited"))
          throw new Error("follow-up did not see edited file");
        yield { type: "text_start", id: "reply" };
        yield {
          type: "text_delta",
          id: "reply",
          text: followUp ? "File is still present" : "Read, wrote and tested",
        };
        yield { type: "text_end", id: "reply" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 9, outputTokens: 5 } };
      }
    },
  } as unknown as Model;
}

test(
  "Pi SDK with fake ZCode executor reads, writes, tests and follows up over two turns",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-pi-loop-"));
    const worktree = join(root, "worktree");
    await mkdir(worktree);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "SECRET_OUTSIDE");
    await symlink(outside, join(worktree, "input.txt"));
    const registry = new HarnessRegistry();
    const adapter = new PiHarnessAdapter({
      root: join(root, "workers"),
      modelFactory: () => scriptedModel(),
    });
    registry.register(adapter);
    const spec = {
      schemaVersion: 2 as const,
      projectId: "fixture-project",
      workspaceId: "fixture-workspace",
      hostSessionId: "pi-loop",
      execution: {
        targetId: "local",
        workspaceIdentity: "fixture-loop",
        worktreePath: worktree,
        worktreeGeneration: "fixture-generation",
        cwdRelativeToWorktree: ".",
      },
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: {
          providerId: "test-provider",
          modelId: "test-model",
          options: { reasoningLevel: "off" },
        },
      },
    };
    const target = {
      id: "local",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux",
      available: true,
    };
    let host: SessionHost | undefined;
    try {
      host = await SessionHost.create({
        root: join(root, "journals"),
        spec,
        target,
        registry,
        catalog: { fingerprint: "fixture-v1", validateSelection: () => ({ ok: true }) },
      });
      const approvals: string[] = [];
      const summaries = new Map<string, string>();
      const requested = new Set<string>();
      host.subscribe((event) => {
        if (event.kind === "interaction.requested") {
          assert.equal(event.turnId, "first-turn");
          assert.equal(event.toolCallId, event.interactionId);
          if (event.toolCallId === "bash-1")
            assert.equal(event.summary, "Run Pi bash command: test -f output.txt");
          else {
            assert.match(
              event.summary,
              /^Allow Pi (write|edit) output\.txt \([0-9]+ bytes, HMAC-SHA-256 [a-f0-9]{16}\)\?$/,
            );
            assert.doesNotMatch(event.summary, /denied|fixture written|SECRET_OUTSIDE/);
          }
          summaries.set(event.interactionId, event.summary);
          approvals.push(event.interactionId);
          requested.add(event.interactionId);
        }
      });
      await host.dispatch({
        type: "send",
        commandId: "first",
        hostSessionId: "pi-loop",
        turnId: "first-turn",
        text: "Read input, write output, run test",
      });
      const waitFor = async (count: number) => {
        const deadline = Date.now() + 8000;
        while (approvals.length < count && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          approvals.length,
          count,
          `Expected ${count} approvals, got ${approvals.length}; events: ${host!.eventsSince(0).map((e) => e.kind)}`,
        );
      };
      await waitFor(1);
      assert.equal(approvals[0], "write-denied");
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "deny-write",
        hostSessionId: "pi-loop",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "first-turn",
        interactionId: approvals[0]!,
        decision: "deny",
      });
      await waitFor(2);
      await assert.rejects(readFile(join(worktree, "output.txt")), { code: "ENOENT" });
      assert.equal(approvals[1], "write-1");
      assert.notEqual(summaries.get("write-denied"), summaries.get("write-1"));
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "allow-write",
        hostSessionId: "pi-loop",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "first-turn",
        interactionId: approvals[1]!,
        decision: "allow",
      });
      await waitFor(3);
      assert.equal(approvals[2], "edit-1");
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "allow-edit",
        hostSessionId: "pi-loop",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "first-turn",
        interactionId: approvals[2]!,
        decision: "allow",
      });
      await waitFor(4);
      assert.equal(approvals[3], "bash-1");
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "allow-bash",
        hostSessionId: "pi-loop",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "first-turn",
        interactionId: approvals[3]!,
        decision: "allow",
      });
      await host.whenIdle();
      assert.equal(await readFile(outside, "utf8"), "SECRET_OUTSIDE");
      assert.equal(await readFile(join(worktree, "output.txt"), "utf8"), "fixture edited");
      assert.equal(requested.size, 4);
      assert.equal(
        host
          .snapshot()
          .rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "Read, wrote and tested",
          ),
        true,
      );
      await host.dispatch({
        type: "send",
        commandId: "follow-up",
        hostSessionId: "pi-loop",
        turnId: "second-turn",
        text: "Follow up",
      });
      await host.whenIdle();
      assert.equal(
        host
          .snapshot()
          .rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "File is still present",
          ),
        true,
      );
      await host.dispatch({
        type: "terminateSession",
        commandId: "terminate",
        hostSessionId: "pi-loop",
      });
      await host.close();
      host = undefined;
    } finally {
      if (host) {
        try {
          await host.dispatch({
            type: "terminateSession",
            commandId: "cleanup",
            hostSessionId: "pi-loop",
          });
          await host.close();
        } catch {
          /* isolated fixture */
        }
      }
      // 修复：能力门禁可能拒绝 Host 终止命令，测试必须单独关闭自己的隔离 worker。
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
