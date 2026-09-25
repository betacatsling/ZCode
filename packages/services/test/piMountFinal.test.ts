import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, readFile, rm, rename, symlink, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

// This fixture uses the actual Host → worker → pinned SDK → broker route, not a helper.
test(
  "mounted native Write accepts owned 0200 files, denies without truncation then truncates after approval",
  { timeout: 30000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-final-write-"));
    const tree = join(fixture, "tree");
    const outside = join(fixture, "outside.txt");
    const targetFile = join(tree, "file.txt");
    await mkdir(tree);
    await writeFile(outside, "SECRET_OUTSIDE");
    await writeFile(targetFile, "long-original-content");
    await chmod(targetFile, 0o200);
    const model = {
      providerId: "fixture",
      modelId: "fixture",
      displayName: "fixture",
      properties: { contextWindow: 32000 },
      optionSpecs: { maxOutputTokens: { max: 1000 } },
      options: { reasoningLevel: "off" },
      async *streamText(request: Parameters<Model["streamText"]>[0]) {
        const tools = request.tools ?? [];
        const read = tools.find((tool) => tool.name === "read");
        const write = tools.find((tool) => tool.name === "write");
        assert.match(read?.description ?? "", /Images are unsupported/);
        assert.match(write?.description ?? "", /Parent directory must already exist/);
        assert.doesNotMatch(write?.description ?? "", /Automatically creates parent directories/);
        const count = request.messages.filter((message) => message.role === "tool").length;
        yield { type: "start", modelId: "fixture" };
        if (count < 2) {
          const id = count === 0 ? "denied" : "allowed";
          const call = { id, name: "write", input: { path: "file.txt", content: "ok" } };
          yield { type: "tool_input_start", id, toolName: call.name };
          yield { type: "tool_input_delta", id, delta: JSON.stringify(call.input) };
          yield { type: "tool_input_end", id };
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
          projectId: "fixture",
          workspaceId: "fixture",
          hostSessionId: "write-only",
          execution: {
            targetId: "local",
            workspaceIdentity: "fixture",
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
        hostSessionId: "write-only",
        turnId: "turn",
        text: "write",
      });
      async function awaitApproval(count: number) {
        const until = Date.now() + 8000;
        while (approvals.length < count && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(
          approvals.length,
          count,
          `approval missing; root/elevated UID=${process.getuid?.() ?? "unknown"}, fixture user=${userInfo().username}`,
        );
      }
      await awaitApproval(1);
      assert.equal(approvals[0], "denied");
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "deny",
        hostSessionId: "write-only",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "turn",
        interactionId: "denied",
        decision: "deny",
      });
      await awaitApproval(2);
      // Root bypasses discretionary read permissions; label this platform limitation explicitly.
      if (process.getuid?.() !== 0)
        await assert.rejects(readFile(targetFile, "utf8"), { code: "EACCES" });
      await chmod(targetFile, 0o600);
      assert.equal(await readFile(targetFile, "utf8"), "long-original-content");
      await chmod(targetFile, 0o200);
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "allow",
        hostSessionId: "write-only",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "turn",
        interactionId: "allowed",
        decision: "allow",
      });
      await host.whenIdle();
      await chmod(targetFile, 0o600);
      assert.equal(await readFile(targetFile, "utf8"), "ok");
      assert.equal(await readFile(outside, "utf8"), "SECRET_OUTSIDE");
      assert.equal(
        host
          .eventsSince(0)
          .some(
            (event) =>
              event.kind === "tool.finished" &&
              event.toolCallId === "allowed" &&
              event.outcome === "success",
          ),
        true,
      );
    } finally {
      await chmod(targetFile, 0o600).catch(() => {});
      if (host) await host.close().catch(() => {});
      await adapter.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

function fakeToolModel(
  mode: "read" | "write" | "bash",
  input: object,
  check?: (request: Parameters<Model["streamText"]>[0]) => void,
): Model {
  return {
    providerId: "fixture",
    modelId: "fixture",
    displayName: "fixture",
    properties: { contextWindow: 32000 },
    optionSpecs: { maxOutputTokens: { max: 1000 } },
    options: { reasoningLevel: "off" },
    async *streamText(request: Parameters<Model["streamText"]>[0]) {
      yield { type: "start", modelId: "fixture" };
      if (!request.messages.some((message) => message.role === "tool")) {
        yield { type: "tool_input_start", id: "call", toolName: mode };
        yield { type: "tool_input_delta", id: "call", delta: JSON.stringify(input) };
        yield { type: "tool_input_end", id: "call" };
        yield { type: "tool_call", toolCall: { id: "call", name: mode, input } };
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 2, outputTokens: 2 },
        };
      } else {
        check?.(request);
        yield { type: "text_start", id: "done" };
        yield { type: "text_delta", id: "done", text: "done" };
        yield { type: "text_end", id: "done" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 2, outputTokens: 2 } };
      }
    },
  } as unknown as Model;
}

async function mountedFixture(
  fixture: string,
  tree: string,
  adapter: PiHarnessAdapter,
): Promise<SessionHost> {
  const registry = new HarnessRegistry();
  registry.register(adapter);
  return SessionHost.create({
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
      projectId: "fixture",
      workspaceId: "fixture",
      hostSessionId: "crash-or-race",
      execution: {
        targetId: "local",
        workspaceIdentity: "fixture",
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
}

// The parent Node hook fires from the actual SDK wrapper after broker preparation and
// immediately before the SDK's resolveReadPathAsync. No time-based race window.
test(
  "actual worker Read swaps leaf between prepared FD and pinned SDK resolver",
  { timeout: 25000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-final-read-"));
    const tree = join(fixture, "tree");
    await mkdir(tree);
    const outside = join(fixture, "outside.txt");
    await writeFile(outside, "SECRET_OUTSIDE");
    await writeFile(join(tree, "file.txt"), "APPROVED_ORIGINAL\nline-two");
    // Pin the installed SDK implementation, not a helper approximation: its Read awaits
    // resolveReadPathAsync(path), whose existence probe targets only the supplied path.
    const sdkTools = join(
      dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
      "core",
      "tools",
    );
    assert.match(
      await readFile(join(sdkTools, "read.js"), "utf8"),
      /await resolveReadPathAsync\(path, ctx\?\.cwd \|\| cwd\)/,
    );
    assert.match(
      await readFile(join(sdkTools, "path-utils.js"), "utf8"),
      /if \(await pathExists\(resolved\)\)/,
    );
    let crossed = 0;
    const adapter = new PiHarnessAdapter({
      root: join(fixture, "workers"),
      modelFactory: () =>
        fakeToolModel("read", { path: "file.txt", offset: 2, limit: 1 }, (request) => {
          const messages = JSON.stringify(request.messages);
          assert.match(messages, /line-two/);
          assert.doesNotMatch(messages, /SECRET_OUTSIDE/);
        }),
      nodeTestHooks: {
        beforeReadResolver: async (alias) => {
          assert.match(alias, /^\/dev\/fd\/\d+$/);
          assert.notEqual(alias, join(tree, "file.txt"));
          crossed++;
          assert.equal(crossed, 1);
          await rename(join(tree, "file.txt"), join(tree, "held.txt"));
          await symlink(outside, join(tree, "file.txt"));
        },
      },
    });
    let host: SessionHost | undefined;
    try {
      host = await mountedFixture(fixture, tree, adapter);
      await host.dispatch({
        type: "send",
        commandId: "send",
        hostSessionId: "crash-or-race",
        turnId: "turn",
        text: "read",
      });
      await host.whenIdle();
      assert.equal(crossed, 1);
      assert.equal(await readFile(outside, "utf8"), "SECRET_OUTSIDE");
      assert.equal(await readFile(join(tree, "held.txt"), "utf8"), "APPROVED_ORIGINAL\nline-two");
      assert.equal(
        host
          .eventsSince(0)
          .some(
            (e) => e.kind === "tool.finished" && e.toolCallId === "call" && e.outcome === "success",
          ),
        true,
      );
    } finally {
      if (host) await host.close().catch(() => {});
      await adapter.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "unexpected actual SDK worker crash reaps owned broker child before Host settles pending Write",
  { timeout: 25000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-final-crash-"));
    const tree = join(fixture, "tree");
    await mkdir(tree);
    const receipts: string[] = [];
    const adapter = new PiHarnessAdapter({
      root: join(fixture, "workers"),
      modelFactory: () => fakeToolModel("write", { path: "new.txt", content: "NEVER" }),
      nodeTestHooks: { brokerExited: (callId) => receipts.push(callId) },
    });
    let host: SessionHost | undefined;
    try {
      host = await mountedFixture(fixture, tree, adapter);
      let approval!: () => void;
      const requested = new Promise<void>((resolve) => {
        approval = resolve;
      });
      host.subscribe((event) => {
        if (event.kind === "interaction.requested") approval();
      });
      const send = await host.dispatch({
        type: "send",
        commandId: "send",
        hostSessionId: "crash-or-race",
        turnId: "turn",
        text: "write",
      });
      assert.equal(send.status, "accepted");
      await requested;
      await assert.rejects(readFile(join(tree, "new.txt")), { code: "ENOENT" });
      adapter.crashWorkerForNodeTest("crash-or-race");
      await host.whenIdle();
      assert.deepEqual(receipts, ["call"]); // ChildProcess 'exit', not PID polling or broker message.
      assert.deepEqual(adapter.pendingForNodeTest("crash-or-race"), { effects: 0, requests: 0 });
      await assert.rejects(readFile(join(tree, "new.txt")), { code: "ENOENT" });
      assert.equal(host.queryCommand("send")?.status, "execution-unknown");
      assert.notEqual(host.getActivity(), "idle");
    } finally {
      if (host) await host.close().catch(() => {});
      await adapter.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

test(
  "unexpected worker crash aborts and awaits an actual SDK Bash child",
  { timeout: 25000 },
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), "pi-final-bash-"));
    const tree = join(fixture, "tree");
    await mkdir(tree);
    // The command creates only a marker under the temporary worktree, then sleeps; the
    // unexecuted trailing effect would reveal a detached/orphaned shell.
    const adapter = new PiHarnessAdapter({
      root: join(fixture, "workers"),
      modelFactory: () =>
        fakeToolModel("bash", {
          command: "printf ready > started.txt; sleep 20; printf ORPHAN > after.txt",
        }),
      nodeTestHooks: {
        bashSettled: () => {
          settled();
        },
      },
    });
    let settled!: () => void;
    const bashReceipt = new Promise<void>((resolve) => {
      settled = resolve;
    });
    let host: SessionHost | undefined;
    try {
      host = await mountedFixture(fixture, tree, adapter);
      let approve!: () => void;
      const requested = new Promise<void>((resolve) => {
        approve = resolve;
      });
      host.subscribe((event) => {
        if (event.kind === "interaction.requested") approve();
      });
      await host.dispatch({
        type: "send",
        commandId: "send",
        hostSessionId: "crash-or-race",
        turnId: "turn",
        text: "run",
      });
      await requested;
      await host.dispatch({
        type: "resolveInteraction",
        commandId: "approve",
        hostSessionId: "crash-or-race",
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: "turn",
        interactionId: "call",
        decision: "allow",
      });
      // Event-driven FS notification: only crash after the real SDK shell executed its marker.
      if (!(await readFile(join(tree, "started.txt"), "utf8").catch(() => ""))) {
        await new Promise<void>((resolve, reject) => {
          const watcher = watch(tree, async () => {
            if (await readFile(join(tree, "started.txt"), "utf8").catch(() => "")) {
              watcher.close();
              resolve();
            }
          });
          watcher.on("error", reject);
          void readFile(join(tree, "started.txt"), "utf8").then(
            () => {
              watcher.close();
              resolve();
            },
            () => {},
          );
        });
      }
      assert.equal(await readFile(join(tree, "started.txt"), "utf8"), "ready");
      adapter.crashWorkerForNodeTest("crash-or-race");
      await host.whenIdle();
      await bashReceipt; // SDK createLocalBashOperations waited for child exit after abort.
      assert.deepEqual(adapter.pendingForNodeTest("crash-or-race"), { effects: 0, requests: 0 });
      await assert.rejects(readFile(join(tree, "after.txt")), { code: "ENOENT" });
      assert.equal(host.queryCommand("send")?.status, "execution-unknown");
    } finally {
      if (host) await host.close().catch(() => {});
      await adapter.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
