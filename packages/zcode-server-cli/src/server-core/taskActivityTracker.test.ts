import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import { agentEventSchema } from "@zcode/shared/agent-host";
import type { AgentHostActivityIndex, AgentHostActivityIndexEntry } from "@zcode/services";
import type { AgentEvent, SessionSpec } from "@zcode/shared/agent-host";
import { agentHostActivityKey, createTaskActivityTracker } from "./taskActivityTracker.js";

const spec = (
  hostSessionId: string,
  overrides: Partial<SessionSpec["execution"]> & { harnessId?: string } = {},
): SessionSpec => {
  const { harnessId = "pi", ...execution } = overrides;
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: "target-local",
      workspaceIdentity: "/repo",
      worktreePath: "/repo",
      ...execution,
    },
    harness: { id: harnessId, adapterVersion: "test" },
    modelBinding: { kind: "harness-managed" },
  };
};

const indexEntry = (
  session: SessionSpec,
  input: Partial<AgentHostActivityIndexEntry> = {},
): AgentHostActivityIndexEntry => ({
  spec: session,
  runtimeEpoch: "epoch-1",
  sequence: 0,
  state: "idle",
  activeTurnId: null,
  pendingInteractionIds: [],
  ...input,
});

const index = (...sessions: AgentHostActivityIndexEntry[]): AgentHostActivityIndex => ({
  targetId: "target-local",
  complete: true,
  sessions,
});

function event(
  session: SessionSpec,
  sequence: number,
  input: Record<string, unknown>,
  runtimeEpoch = "epoch-1",
): AgentEvent {
  return agentEventSchema.parse({
    hostSessionId: session.hostSessionId,
    runtimeEpoch,
    sequence,
    eventId: `${session.hostSessionId}-${runtimeEpoch}-${sequence}`,
    at: sequence,
    ...input,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("errors, interaction resolution, stale turns, and non-idle statuses keep activity busy", async () => {
  const session = spec("session-1");
  const events = new Emitter<{ spec: SessionSpec; event: AgentEvent }>();
  const tracker = createTaskActivityTracker(undefined, {
    onEvent: events.event,
    readIndex: async () =>
      index(
        indexEntry(session, {
          sequence: 1,
          state: "busy",
          activeTurnId: "turn-current",
          pendingInteractionIds: ["approval-1"],
        }),
      ),
    retryIntervalMs: 60_000,
  });
  await tracker.whenReady();
  assert.equal(tracker.readRunningTaskCount(), 1);

  events.fire({
    spec: session,
    event: event(session, 2, {
      kind: "session.error",
      code: "worker-error",
      message: "worker exited",
    }),
  });
  events.fire({
    spec: session,
    event: event(session, 3, {
      kind: "session.status",
      state: "interrupted",
    }),
  });
  events.fire({
    spec: session,
    event: event(session, 4, {
      kind: "interaction.resolved",
      interactionId: "approval-1",
      decision: "deny",
      turnId: "turn-current",
    }),
  });
  events.fire({
    spec: session,
    event: event(session, 5, {
      kind: "turn.finished",
      turnId: "older-turn",
      outcome: "success",
    }),
  });
  assert.equal(tracker.readRunningTaskCount(), 1);

  events.fire({
    spec: session,
    event: event(session, 6, {
      kind: "turn.finished",
      turnId: "turn-current",
      outcome: "failed",
    }),
  });
  assert.equal(tracker.readRunningTaskCount(), 0);
  tracker.dispose();
});

test("snapshot/event race honors epoch, sequence, and active-turn fences", async () => {
  const session = spec("session-1");
  const events = new Emitter<{ spec: SessionSpec; event: AgentEvent }>();
  const firstRead = deferred<AgentHostActivityIndex>();
  const tracker = createTaskActivityTracker(undefined, {
    onEvent: events.event,
    readIndex: () => firstRead.promise,
    retryIntervalMs: 60_000,
  });
  events.fire({
    spec: session,
    event: event(session, 1, { kind: "turn.started", turnId: "turn-new" }),
  });
  events.fire({
    spec: session,
    event: event(session, 2, {
      kind: "turn.finished",
      turnId: "turn-old",
      outcome: "success",
    }),
  });
  firstRead.resolve(
    index(
      indexEntry(session, {
        runtimeEpoch: "epoch-1",
        sequence: 0,
        state: "idle",
      }),
    ),
  );
  await tracker.whenReady();
  assert.equal(tracker.readRunningTaskCount(), 1);

  events.fire({
    spec: session,
    event: event(session, 2, {
      kind: "turn.finished",
      turnId: "turn-new",
      outcome: "success",
    }),
  });
  assert.equal(
    tracker.readRunningTaskCount(),
    1,
    "a duplicate sequence must not release the current turn",
  );
  events.fire({
    spec: session,
    event: event(
      session,
      3,
      {
        kind: "turn.finished",
        turnId: "turn-new",
        outcome: "success",
      },
      "old-epoch",
    ),
  });
  assert.equal(
    tracker.readRunningTaskCount(),
    1,
    "an event from another epoch cannot release activity",
  );

  tracker.dispose();
});

test("events delivered while the initial target index is in flight are replayed after its fence", async () => {
  const session = spec("session-1");
  const events = new Emitter<{ spec: SessionSpec; event: AgentEvent }>();
  const firstRead = deferred<AgentHostActivityIndex>();
  const tracker = createTaskActivityTracker(undefined, {
    onEvent: events.event,
    readIndex: () => firstRead.promise,
    retryIntervalMs: 60_000,
  });
  events.fire({
    spec: session,
    event: event(session, 1, { kind: "turn.started", turnId: "turn-1" }),
  });
  events.fire({
    spec: session,
    event: event(session, 2, {
      kind: "turn.finished",
      turnId: "turn-1",
      outcome: "success",
    }),
  });
  firstRead.resolve(index(indexEntry(session, { sequence: 0, state: "idle" })));
  await tracker.whenReady();
  assert.equal(tracker.readRunningTaskCount(), 0);
  tracker.dispose();
});

test("a complete target rescan clears enumeration uncertainty; time alone does not", async () => {
  const session = spec("session-1");
  const events = new Emitter<{ spec: SessionSpec; event: AgentEvent }>();
  let reads = 0;
  const tracker = createTaskActivityTracker(undefined, {
    onEvent: events.event,
    async readIndex() {
      reads += 1;
      if (reads === 1) throw new Error("index unavailable");
      return index(indexEntry(session));
    },
    retryIntervalMs: 60_000,
  });
  await tracker.whenReady();
  assert.equal(tracker.readRunningTaskCount(), 1);
  await tracker.refreshExternalActivity();
  assert.equal(tracker.readRunningTaskCount(), 0);
  assert.equal(reads, 2);
  tracker.dispose();
});

test("activity keys isolate a reused session ID across targets, workspaces, and harnesses", async () => {
  const first = spec("same-id");
  const second = spec("same-id", { workspaceIdentity: "/other", worktreePath: "/other" });
  const third = spec("same-id", { harnessId: "codex" });
  const remote = spec("same-id", { targetId: "target-remote" });
  assert.equal(new Set([first, second, third, remote].map(agentHostActivityKey)).size, 4);
  const events = new Emitter<{ spec: SessionSpec; event: AgentEvent }>();
  const tracker = createTaskActivityTracker(undefined, {
    onEvent: events.event,
    readIndex: async () =>
      index(
        indexEntry(first, { state: "busy", activeTurnId: "turn-1" }),
        indexEntry(second, { state: "busy", activeTurnId: "turn-1" }),
        indexEntry(third, { state: "busy", activeTurnId: "turn-1" }),
      ),
    retryIntervalMs: 60_000,
  });
  await tracker.whenReady();
  assert.equal(tracker.readRunningTaskCount(), 3);
  events.fire({
    spec: first,
    event: event(first, 1, { kind: "turn.finished", turnId: "turn-1", outcome: "success" }),
  });
  assert.equal(tracker.readRunningTaskCount(), 2);
  tracker.dispose();
});
