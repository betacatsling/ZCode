import assert from "node:assert/strict";
import test from "node:test";
import {
  failClaudeRuntime,
  finishClaudeTurn,
  markClaudeTurnUnknown,
  stopClaudeRuntime,
  translateClaudeRuntimeMessage,
} from "../src/agent-adapters/claude/claudeRuntimeOutcome.js";
import {
  CLAUDE_UNIT,
  claudeUnitPendingApproval,
  claudeUnitRuntime,
  claudeUnitTurn,
  eventKinds,
} from "./fixtures/claudeUnitFixtures.js";

function settled(promise: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
}

test("finishClaudeTurn success reports usage, idles the session and resolves the turn", async () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  const approval = claudeUnitPendingApproval(runtime, turn.hostTurnId);
  runtime.toolCalls.set("a", {} as never);
  runtime.toolBlocks.set("b", {} as never);
  runtime.resolvedInteractionIds.add("interaction-0");
  runtime.activeNativeMessageId = "native-message";

  finishClaudeTurn(runtime, turn, {
    subtype: "success",
    is_error: false,
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2,
      output_tokens: 7,
    },
  });

  assert.deepEqual(eventKinds(events), [
    "usage.reported",
    "turn.finished:success",
    "session.status",
  ]);
  const usage = events[0] as Extract<(typeof events)[number], { kind: "usage.reported" }>;
  assert.equal(usage.inputTokens, 17, "input includes cache read and cache creation tokens");
  assert.equal(usage.outputTokens, 7);
  assert.equal(usage.turnId, turn.hostTurnId);
  assert.equal(events[2]?.kind === "session.status" && events[2].state, "idle");
  assert.equal(runtime.activeTurn, undefined);
  assert.equal(runtime.toolCalls.size, 0);
  assert.equal(runtime.toolBlocks.size, 0);
  assert.equal(runtime.resolvedInteractionIds.size, 0);
  assert.equal(runtime.activeNativeMessageId, undefined);
  assert.equal(runtime.pendingApprovals.size, 0);
  assert.equal(await approval, "deny", "pending approvals are denied when the turn ends");
  assert.equal(await settled(turn.completion.promise), "resolved");
  assert.equal(runtime.failed, undefined);
});

test("finishClaudeTurn maps is_error and non-success subtypes to a failed turn", async () => {
  for (const result of [
    { subtype: "success", is_error: true },
    { subtype: "error_max_turns", is_error: false },
    { is_error: false },
  ]) {
    const { runtime, events } = claudeUnitRuntime();
    const turn = claudeUnitTurn(runtime);
    finishClaudeTurn(runtime, turn, result);
    assert.deepEqual(
      eventKinds(events),
      ["session.error:claude-turn-failed", "turn.finished:failed", "session.status"],
      JSON.stringify(result),
    );
    assert.equal(await settled(turn.completion.promise), "resolved");
  }
});

test("finishClaudeTurn reports a Host cancellation as cancelled, not failed", () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  finishClaudeTurn(runtime, turn, { subtype: "error_during_execution", zcodeOutcome: "cancelled" });
  assert.deepEqual(eventKinds(events), ["turn.finished:cancelled", "session.status"]);
});

test("finishClaudeTurn emits turn.started first for a turn that never started", () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime, "turn-late", false);
  finishClaudeTurn(runtime, turn, { subtype: "success" });
  assert.deepEqual(eventKinds(events), ["turn.started", "turn.finished:success", "session.status"]);
  assert.equal(turn.started, true);
});

test("finishClaudeTurn ignores a stale turn", async () => {
  const { runtime, events } = claudeUnitRuntime();
  const stale = claudeUnitTurn(runtime, "turn-stale");
  const current = claudeUnitTurn(runtime, "turn-current");
  finishClaudeTurn(runtime, stale, { subtype: "success" });
  assert.deepEqual(events, []);
  assert.equal(runtime.activeTurn, current);
  assert.equal(await settled(stale.completion.promise), "pending");
});

test("finishClaudeTurn skips usage unless input and output token counts are safe integers", () => {
  for (const usage of [
    undefined,
    [],
    { input_tokens: 1 },
    { output_tokens: 1 },
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: "1", output_tokens: 1 },
    { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const { runtime, events } = claudeUnitRuntime();
    finishClaudeTurn(runtime, claudeUnitTurn(runtime), { subtype: "success", usage });
    assert.equal(
      events.some((event) => event.kind === "usage.reported"),
      false,
      JSON.stringify(usage),
    );
  }
  const { runtime, events } = claudeUnitRuntime();
  finishClaudeTurn(runtime, claudeUnitTurn(runtime), {
    subtype: "success",
    usage: {
      input_tokens: 3,
      cache_read_input_tokens: -4,
      cache_creation_input_tokens: "x",
      output_tokens: 0,
    },
  });
  const usage = events.find((event) => event.kind === "usage.reported");
  assert.ok(usage && usage.kind === "usage.reported");
  assert.equal(usage.inputTokens, 3, "invalid cache counts count as zero");
  assert.equal(usage.outputTokens, 0);
});

test("markClaudeTurnUnknown fails the runtime, rejects the turn and denies approvals", async () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime, "turn-unknown", false);
  const approval = claudeUnitPendingApproval(runtime, turn.hostTurnId);
  runtime.toolCalls.set("a", {} as never);
  markClaudeTurnUnknown(runtime, turn, "tool may have run");
  assert.deepEqual(eventKinds(events), [
    "turn.started",
    "session.error:execution-unknown",
    "turn.finished:unknown",
  ]);
  const error = events[1];
  assert.equal(error?.kind === "session.error" && error.message, "tool may have run");
  assert.equal(runtime.activeTurn, undefined);
  assert.match(runtime.failed?.message ?? "", /may have executed/);
  assert.equal(runtime.toolCalls.size, 0);
  assert.equal(await approval, "deny");
  await assert.rejects(turn.completion.promise, /may have executed/);
});

test("markClaudeTurnUnknown ignores a stale turn", async () => {
  const { runtime, events } = claudeUnitRuntime();
  const stale = claudeUnitTurn(runtime, "turn-stale");
  claudeUnitTurn(runtime, "turn-current");
  markClaudeTurnUnknown(runtime, stale, "late");
  assert.deepEqual(events, []);
  assert.equal(runtime.failed, undefined);
  assert.equal(await settled(stale.completion.promise), "pending");
});

test("failClaudeRuntime without an active turn reports a process failure and revokes the grant", async () => {
  const { runtime, events, revoked } = claudeUnitRuntime();
  const approval = claudeUnitPendingApproval(runtime, "turn-none");
  const error = new Error("child exited");
  failClaudeRuntime(runtime, error);
  assert.deepEqual(eventKinds(events), ["session.error:claude-process-failure"]);
  assert.equal(runtime.failed, error);
  assert.deepEqual(revoked, ["grant-claude-unit"]);
  assert.equal(await approval, "deny");
});

test("failClaudeRuntime during a turn settles it as execution-unknown", async () => {
  const { runtime, events, revoked } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  failClaudeRuntime(runtime, new Error("child exited"));
  assert.deepEqual(eventKinds(events), [
    "session.error:execution-unknown",
    "turn.finished:unknown",
  ]);
  const error = events[0];
  assert.match(error?.kind === "session.error" ? error.message : "", /\(child exited\)$/);
  assert.deepEqual(revoked, ["grant-claude-unit"]);
  await assert.rejects(turn.completion.promise);
});

test("failClaudeRuntime is a no-op once the runtime is stopping or already failed", () => {
  for (const state of ["stopping", "failed"] as const) {
    const { runtime, events, revoked } = claudeUnitRuntime();
    claudeUnitTurn(runtime);
    if (state === "stopping") runtime.stopping = true;
    else runtime.failed = new Error("first failure");
    failClaudeRuntime(runtime, new Error("second failure"));
    assert.deepEqual(events, [], state);
    assert.deepEqual(revoked, [], state);
    assert.ok(runtime.activeTurn, state);
  }
});

test("stopClaudeRuntime settles the active turn, revokes, clears the lease timer and closes once", async () => {
  const { runtime, events, revoked, calls } = claudeUnitRuntime({ terminateDelayMs: 5 });
  const turn = claudeUnitTurn(runtime);
  let ticks = 0;
  runtime.turnLeaseTimer = setInterval(() => {
    ticks += 1;
  }, 1);
  runtime.turnLeaseTimer.unref();
  const first = stopClaudeRuntime(runtime);
  const second = stopClaudeRuntime(runtime);
  await second;
  assert.ok(calls.includes("process.terminated"), "a concurrent stop waits for the shared stop");
  await first;
  await stopClaudeRuntime(runtime);
  const ticksAfterStop = ticks;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ticks, ticksAfterStop, "the turn lease timer is cleared");
  assert.equal(runtime.stopping, true);
  assert.deepEqual(eventKinds(events), [
    "session.error:execution-unknown",
    "turn.finished:unknown",
  ]);
  assert.deepEqual(revoked, ["grant-claude-unit"]);
  assert.deepEqual(
    calls,
    ["hook.close", "process.terminate", "process.terminated"],
    "concurrent stops share one close",
  );
  await assert.rejects(turn.completion.promise);
});

test("stopClaudeRuntime returns immediately for a runtime already marked stopping", async () => {
  const { runtime, events, revoked, calls } = claudeUnitRuntime();
  runtime.stopping = true;
  await stopClaudeRuntime(runtime);
  assert.deepEqual(events, []);
  assert.deepEqual(revoked, []);
  assert.deepEqual(calls, []);
});

test("translateClaudeRuntimeMessage finishes the active turn on its own result", async () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  translateClaudeRuntimeMessage(runtime, {
    type: "result",
    subtype: "success",
    session_id: CLAUDE_UNIT.backendSessionId,
  });
  assert.deepEqual(eventKinds(events), ["turn.finished:success", "session.status"]);
  assert.equal(await settled(turn.completion.promise), "resolved");
});

test("translateClaudeRuntimeMessage fails the runtime on a protocol violation", async () => {
  const idle = claudeUnitRuntime();
  translateClaudeRuntimeMessage(idle.runtime, { type: "not-a-claude-event" });
  assert.match(idle.runtime.failed?.message ?? "", /unsupported structured stream event/);
  assert.deepEqual(eventKinds(idle.events), ["session.error:claude-process-failure"]);
  assert.deepEqual(idle.revoked, ["grant-claude-unit"]);

  const busy = claudeUnitRuntime();
  const turn = claudeUnitTurn(busy.runtime);
  translateClaudeRuntimeMessage(busy.runtime, {
    type: "result",
    subtype: "success",
    session_id: "another-native-session",
  });
  assert.deepEqual(eventKinds(busy.events), [
    "session.error:execution-unknown",
    "turn.finished:unknown",
  ]);
  const error = busy.events[0];
  assert.match(error?.kind === "session.error" ? error.message : "", /another native session/);
  await assert.rejects(turn.completion.promise);
});

test("a protocol failure with an oversized detail still settles the active turn as unknown", async () => {
  const { runtime, events, revoked } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  // translateSystem interpolates a non-string subtype verbatim (claudeRuntimeEvents.ts:65-68).
  const message = { type: "system", subtype: { detail: "x".repeat(2_000) } };
  assert.doesNotThrow(() => translateClaudeRuntimeMessage(runtime, message));
  assert.deepEqual(eventKinds(events), [
    "session.error:execution-unknown",
    "turn.finished:unknown",
  ]);
  const error = events[0];
  assert.ok(error?.kind === "session.error" && error.message.length <= 1024);
  assert.equal(runtime.activeTurn, undefined);
  assert.deepEqual(revoked, ["grant-claude-unit"]);
  await assert.rejects(turn.completion.promise, /may have executed/);
});

test("markClaudeTurnUnknown bounds its session.error message to the event schema limit", async () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  assert.doesNotThrow(() => markClaudeTurnUnknown(runtime, turn, "y".repeat(5_000)));
  assert.deepEqual(eventKinds(events), [
    "session.error:execution-unknown",
    "turn.finished:unknown",
  ]);
  const error = events[0];
  assert.equal(error?.kind === "session.error" && error.message, "y".repeat(1024));
  await assert.rejects(turn.completion.promise);
});
