import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

test(
  "real Pi SDK worker writes the approved directory inode after parent is swapped before allow",
  { timeout: 20000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-mount-race-"));
    const tree = join(fixture, "tree");
    const outside = join(fixture, "outside");
    await mkdir(join(tree, "nested"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "output.txt"), "SECRET_OUTSIDE");
    const model = {
      providerId: "fixture",
      modelId: "fixture",
      displayName: "fixture",
      properties: { contextWindow: 32000 },
      optionSpecs: { maxOutputTokens: { max: 1000 } },
      options: { reasoningLevel: "off" },
      async *streamText(request: Parameters<Model["streamText"]>[0]) {
        yield { type: "start", modelId: "fixture" };
        if (!request.messages.some((item) => item.role === "tool")) {
          const call = {
            id: "write-swapped",
            name: "write",
            input: { path: "nested/output.txt", content: "approved" },
          };
          yield { type: "tool_input_start", id: call.id, toolName: call.name };
          yield { type: "tool_input_delta", id: call.id, delta: JSON.stringify(call.input) };
          yield { type: "tool_input_end", id: call.id };
          yield { type: "tool_call", toolCall: call };
          yield {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 2, outputTokens: 2 },
          };
        } else {
          yield { type: "text_start", id: "done" };
          yield { type: "text_delta", id: "done", text: "done" };
          yield { type: "text_end", id: "done" };
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 2, outputTokens: 2 },
          };
        }
      },
    } as unknown as Model;
    const adapter = new PiHarnessAdapter({
      root: join(fixture, "workers"),
      modelFactory: () => model,
    });
    const registry = new HarnessRegistry();
    registry.register(adapter);
    const windows = {
      id: "unverified-win",
      kind: "local" as const,
      platform: "win32" as const,
      available: true,
    };
    assert.equal((await adapter.probe(windows)).support, "unsupported");
    assert.equal((await adapter.capabilities(windows)).tools.support, "unsupported");
    let host: SessionHost | undefined;
    try {
      host = await SessionHost.create({
        root: join(fixture, "journal"),
        registry,
        target: {
          id: "local",
          kind: "local",
          platform: process.platform as "darwin" | "linux",
          available: true,
        },
        catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
        spec: {
          schemaVersion: 2,
          projectId: "fixture-project",
          workspaceId: "fixture-workspace",
          hostSessionId: "race",
          execution: {
            targetId: "local",
            workspaceIdentity: "fixture-race",
            worktreePath: tree,
            worktreeGeneration: "gen-1",
            cwdRelativeToWorktree: ".",
          },
          harness: { id: "pi", adapterVersion: "0.87.1" },
          modelBinding: {
            kind: "host-managed",
            selection: {
              providerId: "fixture",
              modelId: "fixture",
              options: { reasoningLevel: "off" },
            },
          },
        },
      });
      const approvals: string[] = [];
      host.subscribe((event) => {
        if (event.kind === "interaction.requested") approvals.push(event.interactionId);
      });
      await host.dispatch({
        type: "send",
        commandId: "send",
        hostSessionId: "race",
        turnId: "turn",
        text: "write",
      });
      const deadline = Date.now() + 5000;
      while (!approvals.length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(approvals, ["write-swapped"]);
      await rename(join(tree, "nested"), join(tree, "original"));
      await symlink(outside, join(tree, "nested"));
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "allow",
        hostSessionId: "race",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "turn",
        interactionId: approvals[0]!,
        decision: "allow",
      });
      await host.whenIdle();
      assert.equal(await readFile(join(outside, "output.txt"), "utf8"), "SECRET_OUTSIDE");
      assert.equal(await readFile(join(tree, "original", "output.txt"), "utf8"), "approved");
    } finally {
      if (host) await host.close().catch(() => {});
      await adapter.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

const mkfifo = promisify(execFile);
for (const scenario of [
  "absent-symlink",
  "absent-existing",
  "edit-leaf",
  "root-swap",
  "cancel-pending",
  "fifo",
  "unreviewable",
] as const) {
  test(
    `real Pi SDK worker refuses or pins ${scenario} after preparation`,
    { timeout: 20000 },
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "pi-worker-boundary-"));
      const tree = join(fixture, "tree");
      const outside = join(fixture, "outside");
      await mkdir(tree);
      await mkdir(outside);
      await writeFile(join(outside, "file.txt"), "SECRET_OUTSIDE");
      if (scenario === "edit-leaf") await writeFile(join(tree, "file.txt"), "inside");
      if (scenario === "fifo") await mkfifo("mkfifo", [join(tree, "file.txt")]);
      const mode = scenario === "edit-leaf" ? "edit" : scenario === "fifo" ? "read" : "write";
      const input =
        mode === "edit"
          ? { path: "file.txt", edits: [{ oldText: "inside", newText: "approved" }] }
          : mode === "write"
            ? {
                path: scenario === "unreviewable" ? `${"x".repeat(185)}.txt` : "file.txt",
                content: "approved",
              }
            : { path: "file.txt" };
      const model = {
        providerId: "fixture",
        modelId: "fixture",
        displayName: "fixture",
        properties: { contextWindow: 32000 },
        optionSpecs: { maxOutputTokens: { max: 1000 } },
        options: { reasoningLevel: "off" },
        async *streamText(request: Parameters<Model["streamText"]>[0]) {
          yield { type: "start", modelId: "fixture" };
          if (!request.messages.some((item) => item.role === "tool")) {
            yield { type: "tool_input_start", id: "file-call", toolName: mode };
            yield { type: "tool_input_delta", id: "file-call", delta: JSON.stringify(input) };
            yield { type: "tool_input_end", id: "file-call" };
            yield { type: "tool_call", toolCall: { id: "file-call", name: mode, input } };
            yield {
              type: "finish",
              finishReason: "tool-calls",
              usage: { inputTokens: 2, outputTokens: 2 },
            };
          } else {
            yield { type: "text_start", id: "done" };
            yield { type: "text_delta", id: "done", text: "done" };
            yield { type: "text_end", id: "done" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 2, outputTokens: 2 },
            };
          }
        },
      } as unknown as Model;
      const adapter = new PiHarnessAdapter({
        root: join(fixture, "workers"),
        modelFactory: () => model,
      });
      const registry = new HarnessRegistry();
      registry.register(adapter);
      let host: SessionHost | undefined;
      try {
        host = await SessionHost.create({
          root: join(fixture, "journal"),
          registry,
          target: {
            id: "local",
            kind: "local",
            platform: process.platform as "darwin" | "linux",
            available: true,
          },
          catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
          spec: {
            schemaVersion: 2,
            projectId: "fixture-project",
            workspaceId: "fixture-workspace",
            hostSessionId: "race",
            execution: {
              targetId: "local",
              workspaceIdentity: "fixture-race",
              worktreePath: tree,
              worktreeGeneration: "gen-1",
              cwdRelativeToWorktree: ".",
            },
            harness: { id: "pi", adapterVersion: "0.87.1" },
            modelBinding: {
              kind: "host-managed",
              selection: {
                providerId: "fixture",
                modelId: "fixture",
                options: { reasoningLevel: "off" },
              },
            },
          },
        });
        const approvals: string[] = [];
        host.subscribe((event) => {
          if (event.kind === "interaction.requested") approvals.push(event.interactionId);
        });
        await host.dispatch({
          type: "send",
          commandId: "send",
          hostSessionId: "race",
          turnId: "turn",
          text: "file",
        });
        if (scenario !== "fifo" && scenario !== "unreviewable") {
          const deadline = Date.now() + 6000;
          while (!approvals.length && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10));
          assert.deepEqual(approvals, ["file-call"]);
          if (scenario === "absent-symlink")
            await symlink(join(outside, "file.txt"), join(tree, "file.txt"));
          if (scenario === "absent-existing") await writeFile(join(tree, "file.txt"), "competing");
          if (scenario === "edit-leaf") {
            await rename(join(tree, "file.txt"), join(tree, "held.txt"));
            await symlink(join(outside, "file.txt"), join(tree, "file.txt"));
          }
          if (scenario === "root-swap") {
            await rename(tree, join(fixture, "held-root"));
            await symlink(outside, tree);
          }
          if (scenario === "cancel-pending") {
            await host.dispatch({
              type: "cancelTurn",
              commandId: "cancel",
              hostSessionId: "race",
              runtimeEpoch: host.binding.runtimeEpoch,
              turnId: "turn",
            });
          } else {
            await host.dispatch({
              type: "resolveInteraction",
              commandId: "allow",
              hostSessionId: "race",
              runtimeEpoch: host.binding.runtimeEpoch,
              turnId: "turn",
              interactionId: "file-call",
              decision: "allow",
            });
          }
        }
        await host.whenIdle();
        assert.equal(await readFile(join(outside, "file.txt"), "utf8"), "SECRET_OUTSIDE");
        if (scenario === "root-swap")
          assert.equal(await readFile(join(fixture, "held-root", "file.txt"), "utf8"), "approved");
        if (scenario === "edit-leaf")
          assert.equal(await readFile(join(tree, "held.txt"), "utf8"), "approved");
        if (scenario === "absent-existing")
          assert.equal(await readFile(join(tree, "file.txt"), "utf8"), "competing");
        if (scenario === "cancel-pending")
          await assert.rejects(readFile(join(tree, "file.txt")), { code: "ENOENT" });
        if (scenario === "unreviewable") {
          assert.equal(approvals.length, 0);
          await assert.rejects(readFile(join(tree, input.path)), { code: "ENOENT" });
        }
        if (scenario === "fifo") {
          assert.equal(approvals.length, 0);
          assert.equal(
            host
              .eventsSince(0)
              .some((event) => event.kind === "tool.finished" && event.outcome === "error"),
            true,
          );
        }
      } finally {
        if (host) await host.close().catch(() => {});
        await adapter.shutdown();
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );
}
