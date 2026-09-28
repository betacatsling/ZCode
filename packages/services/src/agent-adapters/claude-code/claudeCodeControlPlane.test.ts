import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEvent, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import { ClaudeCodeAdapterError } from "./claudeCodeErrors.js";
import { AcpMarkingTransport, FakeClaudeCodeTransport } from "./claudeCodeFakeTransport.js";
import { ClaudeCodeHarnessAdapter } from "./claudeCodeHarnessAdapter.js";
import type { ClaudeCodeNativeEvent } from "./claudeCodeNative.js";
import { createFilesystemClaudeCodeProfileSink, type ClaudeCodeProfileSink } from "./claudeCodeProfile.js";
import { CLAUDE_CODE_ADAPTER_VERSION } from "./claudeCodeVersion.js";

const SECRET = "TEST_ONLY_SECRET_VALUE";

class MemoryProfileSink implements ClaudeCodeProfileSink {
  readonly writes: { path: string; body: string }[] = [];
  readonly removed: string[] = [];
  async writeMarker(path: string, body: string): Promise<void> {
    this.writes.push({ path, body });
  }
  async removeProfile(configDir: string): Promise<void> {
    this.removed.push(configDir);
  }
}

function target(): ExecutionTarget {
  return {
    id: "target-local",
    kind: "local",
    platform: process.platform as ExecutionTarget["platform"],
    available: true,
  };
}

function spec(hostSessionId: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: "target-local",
      workspaceIdentity: "workspace-identity-a",
      worktreePath: "/tmp/worktree-a",
    },
    harness: { id: "claude-code", adapterVersion: CLAUDE_CODE_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" },
  };
}

function waitFor(adapter: ClaudeCodeHarnessAdapter, hostSessionId: string, kind: AgentEvent["kind"]) {
  return new Promise<AgentEvent>((resolve) => {
    const unsubscribe = adapter.subscribe(hostSessionId, (event) => {
      if (event.kind === kind) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}

test("fake transport control plane isolates sessions in one workspace", async () => {
  const sink = new MemoryProfileSink();
  const calls = { inspect: 0 };
  const transport = new FakeClaudeCodeTransport({
    userHome: "/home/user",
    script: ({ turnId, text }) => {
      if (text === "approve") {
        return [
          {
            kind: "text.delta",
            sourceEventId: `${turnId}-d1`,
            turnId,
            messageId: `${turnId}-m`,
            text: "ab",
          },
          {
            kind: "text.delta",
            sourceEventId: `${turnId}-d1`,
            turnId,
            messageId: `${turnId}-m`,
            text: "duplicate",
          },
          {
            kind: "text.delta",
            sourceEventId: `${turnId}-d2`,
            turnId,
            messageId: `${turnId}-m`,
            text: "c",
          },
          {
            kind: "message.finished",
            sourceEventId: `${turnId}-f`,
            turnId,
            messageId: `${turnId}-m`,
            text: "abc",
          },
          {
            kind: "interaction.requested",
            sourceEventId: `${turnId}-i`,
            turnId,
            interactionId: `${turnId}-approval`,
            toolCallId: `${turnId}-tool`,
            summary: "Write a file?",
          },
          {
            kind: "tool.finished",
            sourceEventId: `${turnId}-tool-done`,
            turnId,
            toolCallId: `${turnId}-tool`,
            name: "write",
            outcome: "success",
            outputText: "simulated",
          },
          {
            kind: "turn.finished",
            sourceEventId: `${turnId}-done`,
            turnId,
            outcome: "success",
          },
        ] satisfies ClaudeCodeNativeEvent[];
      }
      return [
        {
          kind: "text.delta",
          sourceEventId: `${turnId}-only`,
          turnId,
          messageId: `${turnId}-m`,
          text: `seen ${SECRET}`,
        },
        {
          kind: "turn.finished",
          sourceEventId: `${turnId}-done`,
          turnId,
          outcome: "success",
        },
      ];
    },
  });
  const adapter = new ClaudeCodeHarnessAdapter({
    managedRoot: "/managed/claude-code",
    userHome: "/home/user",
    transport,
    profileSink: sink,
    secrets: [SECRET],
    now: () => 1_700_000_000_000,
    modelBindingPort: {
      async inspect() {
        calls.inspect += 1;
        return {
          evidence: { kind: "port-mock" },
          reachedModelExecutionLayer: false,
          reason: "unused",
        };
      },
    },
  });
  const bindingA = await adapter.create(spec("session-a"), {} as never);
  const bindingB = await adapter.create(spec("session-b"), {} as never);
  assert.notEqual(bindingA.backendSessionId, bindingB.backendSessionId);
  assert.notEqual(bindingA.backendSessionId, "session-a");
  assert.equal(sink.writes.length, 2);
  assert.notEqual(sink.writes[0]?.path, sink.writes[1]?.path);
  assert.equal(sink.writes.every((write) => write.path.startsWith("/managed/claude-code/")), true);
  assert.equal(JSON.stringify(sink.writes).includes(SECRET), false);
  assert.equal(calls.inspect, 0);

  const pendingA = waitFor(adapter, "session-a", "interaction.requested");
  const turnA = adapter.send({
    type: "send",
    commandId: "send-a",
    hostSessionId: "session-a",
    turnId: "turn-a",
    text: "approve",
  });
  await pendingA;
  await assert.rejects(
    adapter.cancelTurn({
      type: "cancelTurn",
      commandId: "stale",
      hostSessionId: "session-a",
      runtimeEpoch: bindingA.runtimeEpoch,
      turnId: "other-turn",
    }),
    (error: unknown) => error instanceof ClaudeCodeAdapterError && error.code === "stale-turn",
  );
  await adapter.resolveInteraction({
    type: "resolveInteraction",
    commandId: "allow-a",
    hostSessionId: "session-a",
    runtimeEpoch: bindingA.runtimeEpoch,
    turnId: "turn-a",
    interactionId: "turn-a-approval",
    decision: "deny",
  });
  await turnA;
  const eventsA = adapter.readControlSnapshot("session-a");
  assert.equal(eventsA.filter((event) => event.kind === "text.delta").length, 2);
  const finished = eventsA.find((event) => event.kind === "message.finished");
  assert.equal(finished && "text" in finished ? finished.text : "", "abc");
  assert.equal(eventsA.some((event) => event.kind === "tool.finished"), false);
  const terminal = eventsA.at(-1);
  assert.equal(terminal?.kind, "turn.finished");
  if (terminal?.kind === "turn.finished") assert.equal(terminal.outcome, "cancelled");
  assert.deepEqual(
    eventsA.map((event) => event.sequence),
    eventsA.map((_, index) => index + 1),
  );

  const turnB = adapter.send({
    type: "send",
    commandId: "send-b",
    hostSessionId: "session-b",
    turnId: "turn-b",
    text: "hello",
  });
  await turnB;
  const eventsB = adapter.readControlSnapshot("session-b");
  assert.equal(JSON.stringify(eventsB).includes(SECRET), false);
  assert.equal(eventsB.some((event) => event.kind === "text.delta" && event.text === "seen [redacted]"), true);
  assert.equal(calls.inspect, 0);
  assert.equal(transport.promptCount, 2);

  const beforeHistory = transport.promptCount;
  const firstIds = adapter.readControlSnapshot("session-b").map((event) => event.eventId);
  const secondIds = adapter.readControlSnapshot("session-b").map((event) => event.eventId);
  assert.deepEqual(secondIds, firstIds);
  assert.equal(transport.promptCount, beforeHistory);

  const unsubscribe = adapter.subscribe("session-b", () => {
    throw new Error("detach must not keep delivering events");
  });
  unsubscribe();
  await adapter.send({
    type: "send",
    commandId: "send-b2",
    hostSessionId: "session-b",
    turnId: "turn-b2",
    text: "again",
  });
  await adapter.terminate("session-a");
  assert.equal(transport.shutDown, false);
  assert.equal(transport.refCount, 1);
  await adapter.send({
    type: "send",
    commandId: "send-b3",
    hostSessionId: "session-b",
    turnId: "turn-b3",
    text: "still-alive",
  });
  await adapter.shutdown();
  assert.equal(transport.shutDown, true);
  assert.equal(transport.refCount, 0);
});

test("stale epoch and sequence gaps stay on the targeted turn", async () => {
  const transport = new FakeClaudeCodeTransport({
    userHome: "/home/user",
    script: ({ turnId }) => [
      {
        kind: "text.delta",
        sourceEventId: `${turnId}-d`,
        turnId,
        messageId: `${turnId}-m`,
        text: "before-gap",
      },
      { kind: "sequence.gap", sourceEventId: `${turnId}-gap`, turnId },
      {
        kind: "text.delta",
        sourceEventId: `${turnId}-after`,
        turnId,
        messageId: `${turnId}-m`,
        text: "invented",
      },
    ],
  });
  const adapter = new ClaudeCodeHarnessAdapter({
    managedRoot: "/managed/claude-code",
    userHome: "/home/user",
    transport,
    profileSink: new MemoryProfileSink(),
    now: () => 10,
  });
  const binding = await adapter.create(spec("session-gap"), {} as never);
  await adapter.send({
    type: "send",
    commandId: "gap",
    hostSessionId: "session-gap",
    turnId: "turn-gap",
    text: "gap",
  });
  const events = adapter.readControlSnapshot("session-gap");
  assert.equal(events.some((event) => event.kind === "text.delta" && event.text === "invented"), false);
  assert.equal(
    events.some((event) => event.kind === "session.error" && event.code === "execution-unknown"),
    true,
  );
  const finished = events.find((event) => event.kind === "turn.finished");
  assert.equal(finished?.kind === "turn.finished" ? finished.outcome : "", "unknown");
  await assert.rejects(
    adapter.cancelTurn({
      type: "cancelTurn",
      commandId: "late",
      hostSessionId: "session-gap",
      runtimeEpoch: "other-epoch",
      turnId: "turn-gap",
    }),
    (error: unknown) => error instanceof ClaudeCodeAdapterError && error.code === "stale-epoch",
  );
  assert.equal(binding.runtimeEpoch === "other-epoch", false);
  await adapter.shutdown();
});

test("cancel closes a pending approval and a late decision is rejected", async () => {
  const transport = new FakeClaudeCodeTransport({
    userHome: "/home/user",
    delayMs: 30,
    script: ({ turnId }) => [
      {
        kind: "interaction.requested",
        sourceEventId: `${turnId}-i`,
        turnId,
        interactionId: "approval",
        toolCallId: "tool",
        summary: "Run?",
      },
      {
        kind: "tool.finished",
        sourceEventId: `${turnId}-tool`,
        turnId,
        toolCallId: "tool",
        name: "bash",
        outcome: "success",
      },
    ],
  });
  const adapter = new ClaudeCodeHarnessAdapter({
    managedRoot: "/managed/claude-code",
    userHome: "/home/user",
    transport,
    profileSink: new MemoryProfileSink(),
    now: () => 10,
  });
  const binding = await adapter.create(spec("session-cancel"), {} as never);
  const pending = waitFor(adapter, "session-cancel", "interaction.requested");
  const turn = adapter.send({
    type: "send",
    commandId: "send",
    hostSessionId: "session-cancel",
    turnId: "turn-cancel",
    text: "cancel-me",
  });
  await pending;
  await adapter.cancelTurn({
    type: "cancelTurn",
    commandId: "cancel",
    hostSessionId: "session-cancel",
    runtimeEpoch: binding.runtimeEpoch,
    turnId: "turn-cancel",
  });
  await turn;
  const events = adapter.readControlSnapshot("session-cancel");
  assert.equal(events.some((event) => event.kind === "tool.finished"), false);
  const resolved = events.find((event) => event.kind === "interaction.resolved");
  assert.equal(resolved?.kind === "interaction.resolved" ? resolved.decision : "", "deny");
  await assert.rejects(
    adapter.resolveInteraction({
      type: "resolveInteraction",
      commandId: "late",
      hostSessionId: "session-cancel",
      runtimeEpoch: binding.runtimeEpoch,
      turnId: "turn-cancel",
      interactionId: "approval",
      decision: "allow",
    }),
    (error: unknown) => error instanceof ClaudeCodeAdapterError && error.code === "stale-turn",
  );
  await adapter.shutdown();
});

test("ACP transport delivers control events without credentials", async () => {
  const inner = new FakeClaudeCodeTransport({ userHome: "/home/user" });
  const adapter = new ClaudeCodeHarnessAdapter({
    managedRoot: "/managed/claude-code",
    userHome: "/home/user",
    transport: new AcpMarkingTransport(inner),
    profileSink: new MemoryProfileSink(),
    now: () => 10,
  });
  const binding = await adapter.create(spec("session-acp"), {} as never);
  assert.equal(binding.backendSessionId.startsWith("acp-fake-"), true);
  await adapter.send({
    type: "send",
    commandId: "send",
    hostSessionId: "session-acp",
    turnId: "turn-acp",
    text: "hello",
  });
  const events = adapter.readControlSnapshot("session-acp");
  assert.equal(events.some((event) => event.kind === "text.delta"), true);
  assert.equal(events.some((event) => event.kind === "usage.reported"), true);
  const capabilities = await adapter.capabilities(target());
  assert.equal(capabilities.images.support, "unsupported");
  assert.equal(capabilities.modelSwitch.support, "unsupported");
  assert.equal(capabilities.resumeExecution.support, "unsupported");
  assert.ok(capabilities.images.reason);
  await adapter.shutdown();
});

test("profile writes stay out of the user Claude login directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-code-"));
  const userHome = join(root, "home");
  const managedRoot = join(root, "managed");
  const globalClaude = join(userHome, ".claude");
  await mkdir(globalClaude, { recursive: true });
  const adapter = new ClaudeCodeHarnessAdapter({
    managedRoot,
    userHome,
    transport: new FakeClaudeCodeTransport({ userHome }),
    profileSink: createFilesystemClaudeCodeProfileSink({ managedRoot, userHome }),
    env: { ANTHROPIC_API_KEY: SECRET, CLAUDE_CONFIG_DIR: globalClaude },
    now: () => 10,
  });
  await assert.rejects(
    new ClaudeCodeHarnessAdapter({
      managedRoot: globalClaude,
      userHome,
      transport: new FakeClaudeCodeTransport({ userHome }),
      profileSink: new MemoryProfileSink(),
      now: () => 10,
    }).create(spec("rejected"), {} as never),
    (error: unknown) => error instanceof ClaudeCodeAdapterError && error.code === "unsupported",
  );
  await adapter.create(spec("session-fs"), {} as never);
  assert.deepEqual(await readdir(globalClaude), []);
  const profiles = await readdir(join(managedRoot, "profiles"));
  assert.equal(profiles.length, 1);
  const marker = await readFile(
    join(managedRoot, "profiles", profiles[0] ?? "", "config", "zcode-claude-code-profile.json"),
    "utf8",
  );
  assert.equal(marker.includes(SECRET), false);
  assert.equal(marker.includes("isolatesGlobalClaudeLogin"), true);
  const mode = (await stat(join(managedRoot, "profiles", profiles[0] ?? "", "config", "zcode-claude-code-profile.json")))
    .mode;
  assert.equal(mode & 0o777, 0o600);
  await adapter.terminate("session-fs");
  assert.deepEqual(await readdir(globalClaude), []);
  await adapter.shutdown();
});
