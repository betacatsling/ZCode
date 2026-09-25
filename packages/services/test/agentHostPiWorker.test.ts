import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";

const fakeModel = {
  providerId: "provider-a",
  modelId: "model-a",
  displayName: "Fixture model",
  options: { reasoningLevel: "off" },
  properties: { contextWindow: 32000 },
  optionSpecs: { maxOutputTokens: { max: 1000 } },
  async *streamText(request: Parameters<Model["streamText"]>[0]) {
    const hasToolResult = request.messages.some((item) => item.role === "tool");
    const prompt = request.messages.filter((item) => item.role === "user").at(-1)?.content;
    yield { type: "start", modelId: "model-a" };
    if (prompt === "abort now") {
      yield { type: "text_start", id: "abort-text" };
      yield { type: "text_delta", id: "abort-text", text: "Waiting for cancel" };
      await new Promise<void>((resolve) => {
        if (request.abortSignal?.aborted) resolve();
        else request.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", error: new Error("fixture aborted") };
      return;
    }
    if (prompt === "fail now") {
      yield { type: "error", error: new Error("fixture model unavailable") };
      return;
    }
    if (prompt === "partial now") {
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { cacheReadTokens: 0, reasoningTokens: 2 },
      };
      return;
    }
    if (prompt === "total only") {
      yield { type: "finish", finishReason: "stop", usage: { totalTokens: 9 } };
      return;
    }
    if (prompt === "zero now") {
      yield { type: "text_start", id: "zero-text" };
      yield { type: "text_delta", id: "zero-text", text: "Zero measured" };
      yield { type: "text_end", id: "zero-text" };
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    if (!hasToolResult) {
      yield { type: "reasoning_start", id: "visible-thinking" };
      yield { type: "reasoning_delta", id: "visible-thinking", text: "Visible analysis" };
      yield { type: "reasoning_end", id: "visible-thinking" };
      yield { type: "tool_input_start", id: "write-1", toolName: "write" };
      yield {
        type: "tool_input_delta",
        id: "write-1",
        delta: '{"path":"denied.txt","content":"should not exist"}',
      };
      yield { type: "tool_input_end", id: "write-1" };
      yield {
        type: "tool_call",
        toolCall: {
          id: "write-1",
          name: "write",
          input: { path: "denied.txt", content: "should not exist" },
        },
      };
      yield {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 7,
          cacheWriteTokens: 2,
          reasoningTokens: 3,
        },
      };
    } else {
      yield { type: "reasoning_start", id: "opaque" };
      yield { type: "reasoning_delta", id: "opaque", text: "PRIVATE-DELTA-SENTINEL" };
      yield {
        type: "reasoning_end",
        id: "opaque",
        providerMetadata: { anthropic: { redactedData: "PRIVATE-OPAQUE-SENTINEL" } },
      };
      yield { type: "text_start", id: "text-2" };
      yield { type: "text_delta", id: "text-2", text: "Permission denied" };
      yield { type: "text_end", id: "text-2" };
      // An empty Model usage report is not a measured zero, even though Pi requires a zero-filled Usage object.
      yield { type: "finish", finishReason: "stop", usage: {} };
    }
  },
} as unknown as Model;

test(
  "real Pi SDK worker enforces a write approval before executing the tool",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-pi-worker-"));
    const worktree = join(root, "worktree");
    await mkdir(worktree);
    const registry = new HarnessRegistry();
    const adapter = new PiHarnessAdapter({
      root: join(root, "workers"),
      modelFactory: () => ({
        model: fakeModel,
        identity: {
          providerId: "provider-a",
          modelId: "model-a",
          apiType: "anthropic-messages",
          endpointFingerprint: "a".repeat(64),
        },
      }),
    });
    registry.register(adapter);
    const spec = {
      schemaVersion: 2 as const,
      projectId: "fixture-project",
      workspaceId: "fixture-workspace",
      hostSessionId: "pi-test",
      execution: {
        targetId: "local",
        workspaceIdentity: "fixture",
        worktreePath: worktree,
        worktreeGeneration: "fixture-generation",
        cwdRelativeToWorktree: ".",
      },
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: {
          providerId: "provider-a",
          modelId: "model-a",
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
      const received: string[] = [];
      const approval = new Promise<string>((resolve, reject) =>
        host!.subscribe((event) => {
          received.push(
            event.kind === "session.error" ? `session.error:${event.code}` : event.kind,
          );
          if (event.kind === "interaction.requested") resolve(event.interactionId);
          if (event.kind === "turn.finished")
            reject(new Error(`Pi turn finished without approval: ${received.join(",")}`));
        }),
      );
      const sent = await host.dispatch({
        type: "send",
        commandId: "send-1",
        hostSessionId: "pi-test",
        turnId: "turn-1",
        text: "Write denied.txt",
      });
      assert.equal(sent.status, "accepted");
      const interactionId = await Promise.race([
        approval,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Pi approval timed out: ${received.join(",")}`)),
            8000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(
        (
          await host.dispatch({
            type: "resolveInteraction",
            commandId: "deny-1",
            hostSessionId: "pi-test",
            runtimeEpoch: host.binding.runtimeEpoch,
            turnId: "turn-1",
            interactionId,
            decision: "deny",
          })
        ).status,
        "completed",
      );
      await host.whenIdle();
      const recorded = host.eventsSince(0);
      assert.deepEqual(
        recorded.filter((row) => row.kind.startsWith("reasoning.")).map((row) => row.kind),
        ["reasoning.started", "reasoning.delta", "reasoning.finished"],
        JSON.stringify(
          recorded.filter(
            (row) => row.kind.startsWith("reasoning.") || row.kind === "session.error",
          ),
        ),
      );
      assert.equal(
        host.snapshot().rows.window.find((row) => row.kind === "reasoning")?.text,
        "Visible analysis",
      );
      assert.deepEqual(host.snapshot().usage.cumulative, {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
      });
      assert.equal(recorded.filter((row) => row.kind === "usage.accounted").length, 1);
      for (const privateValue of ["PRIVATE-DELTA-SENTINEL", "PRIVATE-OPAQUE-SENTINEL"]) {
        assert.equal(JSON.stringify(recorded).includes(privateValue), false);
        assert.equal(JSON.stringify(host.snapshot()).includes(privateValue), false);
      }
      assert.equal(JSON.stringify(recorded).includes("thinkingSignature"), false);

      assert.equal(host.queryCommand("send-1")?.status, "completed");
      await assert.rejects(readFile(join(worktree, "denied.txt")), { code: "ENOENT" });
      assert.equal(
        host
          .snapshot()
          .rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "Permission denied",
          ),
        true,
      );
      const zero = await host.dispatch({
        type: "send",
        commandId: "send-zero",
        hostSessionId: "pi-test",
        turnId: "turn-zero",
        text: "zero now",
      });
      assert.equal(zero.status, "accepted");
      await host.whenIdle();
      const accounted = host.eventsSince(0).filter((row) => row.kind === "usage.accounted");
      assert.equal(accounted.length, 2);
      assert.equal(accounted[1]?.kind === "usage.accounted" && accounted[1].inputTokens, 0);
      const partial = await host.dispatch({
        type: "send",
        commandId: "send-partial",
        hostSessionId: "pi-test",
        turnId: "turn-partial",
        text: "partial now",
      });
      assert.equal(partial.status, "accepted");
      await host.whenIdle();
      const partialEvent = host
        .eventsSince(0)
        .filter((row) => row.kind === "usage.accounted")
        .at(-1);
      assert.equal(partialEvent?.kind, "usage.accounted");
      if (partialEvent?.kind === "usage.accounted") {
        assert.equal(partialEvent.cacheReadTokens, 0);
        assert.equal(partialEvent.reasoningTokens, 2);
        assert.equal(Object.hasOwn(partialEvent, "inputTokens"), false);
        assert.equal(Object.hasOwn(partialEvent, "outputTokens"), false);
      }
      const totalOnly = await host.dispatch({
        type: "send",
        commandId: "send-total",
        hostSessionId: "pi-test",
        turnId: "turn-total",
        text: "total only",
      });
      assert.equal(totalOnly.status, "accepted");
      await host.whenIdle();
      assert.equal(host.eventsSince(0).filter((row) => row.kind === "usage.accounted").length, 3);
      assert.deepEqual(host.snapshot().usage.cumulative, {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 2,
      });
      const failure = await host.dispatch({
        type: "send",
        commandId: "send-failed",
        hostSessionId: "pi-test",
        turnId: "turn-failed",
        text: "fail now",
      });
      assert.equal(failure.status, "accepted");
      await host.whenIdle();
      assert.equal(host.eventsSince(0).filter((row) => row.kind === "usage.accounted").length, 3);
      assert.equal(
        host.eventsSince(0).some((row) => row.kind === "session.error"),
        true,
      );
      const abortText = new Promise<void>((resolve) => {
        host!.subscribe((event) => {
          if (event.kind === "text.delta" && event.turnId === "turn-aborted") resolve();
        });
      });
      const abort = await host.dispatch({
        type: "send",
        commandId: "send-aborted",
        hostSessionId: "pi-test",
        turnId: "turn-aborted",
        text: "abort now",
      });
      assert.equal(abort.status, "accepted");
      await abortText;
      const cancelled = await host.dispatch({
        type: "cancelTurn",
        commandId: "cancel-aborted",
        hostSessionId: "pi-test",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "turn-aborted",
      });
      assert.equal(cancelled.status, "completed");
      await host.whenIdle();
      assert.equal(host.eventsSince(0).filter((row) => row.kind === "usage.accounted").length, 3);
      assert.equal(
        host
          .eventsSince(0)
          .some(
            (row) =>
              row.kind === "turn.finished" &&
              row.turnId === "turn-aborted" &&
              row.outcome === "cancelled",
          ),
        true,
      );
      await host.dispatch({
        type: "terminateSession",
        commandId: "terminate-1",
        hostSessionId: "pi-test",
      });
      await host.close();
      host = undefined;
    } finally {
      if (host) {
        // Test failure is still not permission to kill an unrelated worker or delete user data.
        try {
          await host.dispatch({
            type: "terminateSession",
            commandId: "cleanup",
            hostSessionId: "pi-test",
          });
          await host.close();
        } catch {
          /* isolated test directory */
        }
      }
      // 修复：Host 的终止命令可因能力门禁拒绝；测试自身必须关闭隔离的 Pi worker，
      // 否则断言已通过但 Node 测试进程仍持有 worker，掩盖资源泄漏。
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
);
