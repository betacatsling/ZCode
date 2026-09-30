import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeAdapterHarness,
  eventsOf,
  startTurn,
  type ClaudeAdapterHarness,
} from "./fixtures/claudeAdapterHarness.js";

// A11: cancelTurn. Safe when no approved tool may have run (cancelled); unsafe after an approved
// tool (execution-unknown). The fake reaches the real hook server and Gateway over loopback.

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function cancelCommand(h: ClaudeAdapterHarness, runtimeEpoch: string, turnId: string) {
  return {
    type: "cancelTurn" as const,
    commandId: `cancel-${turnId}`,
    hostSessionId: h.spec.hostSessionId,
    runtimeEpoch,
    turnId,
  };
}

/** Starts a turn whose fake process asks the Host to approve one Bash call over the hook. */
async function turnWithToolRequest(h: ClaudeAdapterHarness, turnId: string) {
  const { sending } = await startTurn(h, turnId);
  const process = h.launches.at(-1)!;
  const decision = process.preToolUse("toolu_cancel_1", "Bash", { command: "echo cancel" });
  await until(() => eventsOf(h.events, "interaction.requested").length > 0, "the approval request");
  const [request] = eventsOf(h.events, "interaction.requested");
  return { sending, process, decision, interactionId: request!.interactionId };
}

function outcomes(h: ClaudeAdapterHarness): string[] {
  return eventsOf(h.events, "turn.finished").map((event) => event.outcome);
}

test("stale cancellations are refused and the turn keeps running", async (t) => {
  const h = await claudeAdapterHarness(t);
  const { runtimeEpoch } = await h.adapter.create(h.spec, h.plan);
  await assert.rejects(
    h.adapter.cancelTurn(cancelCommand(h, runtimeEpoch, "turn-none")),
    /stale Claude turn cancellation/,
    "no active turn",
  );
  const { sending } = await startTurn(h, "turn-live");
  await assert.rejects(
    h.adapter.cancelTurn(cancelCommand(h, "epoch-other", "turn-live")),
    /stale Claude turn cancellation/,
  );
  await assert.rejects(
    h.adapter.cancelTurn(cancelCommand(h, runtimeEpoch, "turn-other")),
    /stale Claude turn cancellation/,
  );
  const [process] = h.launches;
  assert.deepEqual(process!.calls, []);
  process!.result();
  await sending;
  assert.deepEqual(outcomes(h), ["success"]);
  assert.deepEqual(h.grants.revoked, []);
});

test("cancelling before any tool finishes the turn as cancelled and aborts the process", async (t) => {
  const h = await claudeAdapterHarness(t);
  const { runtimeEpoch } = await h.adapter.create(h.spec, h.plan);
  const { sending } = await startTurn(h, "turn-cancel");
  const [process] = h.launches;
  await h.adapter.cancelTurn(cancelCommand(h, runtimeEpoch, "turn-cancel"));
  await sending;
  assert.deepEqual(outcomes(h), ["cancelled"]);
  assert.deepEqual(eventsOf(h.events, "session.error"), []);
  assert.deepEqual(process!.calls, ["abort"]);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  assert.equal(await process!.gatewayStatus(), 401);

  // The interrupted runtime is failed, so the next turn resumes on a new process.
  const next = await startTurn(h, "turn-next");
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1]!.resumed, true);
  h.launches[1]!.result();
  await next.sending;
});

test("cancelling with an unanswered approval denies it and stays a safe cancel", async (t) => {
  const h = await claudeAdapterHarness(t);
  const { runtimeEpoch } = await h.adapter.create(h.spec, h.plan);
  const { sending, decision } = await turnWithToolRequest(h, "turn-pending");
  await h.adapter.cancelTurn(cancelCommand(h, runtimeEpoch, "turn-pending"));
  assert.equal(await decision, "deny");
  await sending;
  assert.deepEqual(outcomes(h), ["cancelled"]);
  assert.deepEqual(eventsOf(h.events, "interaction.resolved"), []);
});

test("cancelling after a denied tool is still a safe cancel", async (t) => {
  const h = await claudeAdapterHarness(t);
  const { runtimeEpoch } = await h.adapter.create(h.spec, h.plan);
  const { sending, decision, interactionId } = await turnWithToolRequest(h, "turn-denied");
  await h.adapter.resolveInteraction({
    type: "resolveInteraction",
    commandId: "resolve-denied",
    hostSessionId: h.spec.hostSessionId,
    runtimeEpoch,
    turnId: "turn-denied",
    interactionId,
    decision: "deny",
  });
  assert.equal(await decision, "deny");
  await h.adapter.cancelTurn(cancelCommand(h, runtimeEpoch, "turn-denied"));
  await sending;
  assert.deepEqual(outcomes(h), ["cancelled"]);
});

test("cancelling after an approved tool settles the turn as execution-unknown", async (t) => {
  const revokedAtAbort: number[] = [];
  const h = await claudeAdapterHarness(t, {
    behavior: { onAbort: () => revokedAtAbort.push(h.grants.revoked.length) },
  });
  const { runtimeEpoch } = await h.adapter.create(h.spec, h.plan);
  const { sending, process, decision, interactionId } = await turnWithToolRequest(
    h,
    "turn-approved",
  );
  await h.adapter.resolveInteraction({
    type: "resolveInteraction",
    commandId: "resolve-approved",
    hostSessionId: h.spec.hostSessionId,
    runtimeEpoch,
    turnId: "turn-approved",
    interactionId,
    decision: "allow",
  });
  assert.equal(await decision, "allow", "the hook server returned the Host approval");
  assert.equal(await process.gatewayStatus(), 400, "the grant is live while the tool runs");

  await h.adapter.cancelTurn(cancelCommand(h, runtimeEpoch, "turn-approved"));
  await assert.rejects(sending, /may have executed/);
  assert.deepEqual(outcomes(h), ["unknown"]);
  const errors = eventsOf(h.events, "session.error");
  assert.deepEqual(
    errors.map((event) => [event.code, event.message]),
    [["execution-unknown", "Claude was stopped after an approved tool may have started."]],
  );
  assert.deepEqual(process.calls, ["abort"]);
  assert.deepEqual(revokedAtAbort, [1], "the grant is revoked before the abort");
  assert.equal(await process.gatewayStatus(), 401);
  assert.equal(
    await process.preToolUse("toolu_cancel_2", "Bash", { command: "echo again" }),
    "deny",
    "a late tool request from the interrupted process is denied",
  );
});
