import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudePreToolUseInput } from "../src/agent-adapters/claude/claudeApprovalHookServer.js";
import {
  denyPendingClaudeApprovals,
  requestClaudeApproval,
  resolveClaudeApproval,
} from "../src/agent-adapters/claude/claudeHostApproval.js";
import { createClaudeDecision } from "../src/agent-adapters/claude/claudeRuntime.js";
import { upsertToolCall } from "../src/agent-adapters/claude/claudeRuntimeEvents.js";
import {
  CLAUDE_UNIT,
  claudeUnitPendingApproval,
  claudeUnitRuntime,
  claudeUnitTurn,
  eventKinds,
} from "./fixtures/claudeUnitFixtures.js";

// Unit coverage for PreToolUse correlation: each refusal denies with its own reason, and an
// admitted request is decided only by a matching resolveInteraction or by the hook's abort.

function hook(overrides: Partial<ClaudePreToolUseInput> = {}): ClaudePreToolUseInput {
  return {
    hook_event_name: "PreToolUse",
    session_id: CLAUDE_UNIT.backendSessionId,
    tool_name: "Read",
    tool_use_id: "toolu_1",
    tool_input: { file_path: "/a" },
    ...overrides,
  };
}

function correlationMessages(events: ReturnType<typeof claudeUnitRuntime>["events"]): string[] {
  return events.flatMap((event) =>
    event.kind === "session.error" ? [event.message.replace(/^.*\((.*)\)$/, "$1")] : [],
  );
}

const never = new AbortController().signal;

/** Requests an approval and withdraws it after one macrotask, so a wrong admission cannot hang. */
async function requestOnce(
  runtime: ReturnType<typeof claudeUnitRuntime>["runtime"],
  input: ClaudePreToolUseInput,
): Promise<"allow" | "deny"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    return await requestClaudeApproval(runtime, input, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

test("runtime state and session identity refusals deny before any tool is recorded", async () => {
  const cases: [string, (unit: ReturnType<typeof claudeUnitRuntime>) => void, string][] = [
    ["stopping", (unit) => (unit.runtime.stopping = true), "stopping"],
    ["failed", (unit) => (unit.runtime.failed = new Error("x")), "failed"],
    ["idle", (unit) => (unit.runtime.activeTurn = undefined), "no-active-turn"],
  ];
  for (const [, arrange, reason] of cases) {
    const unit = claudeUnitRuntime();
    claudeUnitTurn(unit.runtime);
    arrange(unit);
    assert.equal(await requestClaudeApproval(unit.runtime, hook(), never), "deny");
    assert.deepEqual(correlationMessages(unit.events), [reason]);
    assert.equal(unit.runtime.toolCalls.size, 0);
  }
  const foreign = claudeUnitRuntime();
  claudeUnitTurn(foreign.runtime);
  await requestClaudeApproval(foreign.runtime, hook({ session_id: "other" }), never);
  assert.deepEqual(correlationMessages(foreign.events), [
    `session-mismatch hook=other bind=${CLAUDE_UNIT.backendSessionId}`,
  ]);
});

test("tool identity and input refusals each deny with their own reason", async () => {
  const unit = claudeUnitRuntime();
  const turn = claudeUnitTurn(unit.runtime);
  upsertToolCall(unit.runtime, turn, "toolu_named", "Read", { file_path: "/a" });
  upsertToolCall(unit.runtime, turn, "toolu_array", "Read", { file_path: "/a" });
  const requests: ClaudePreToolUseInput[] = [
    hook({ tool_use_id: "toolu_named", tool_name: "Bash" }),
    hook({ tool_use_id: "toolu_noinput", tool_input: "not-an-object" }),
    hook({ tool_use_id: "toolu_array", tool_input: ["/a"] }),
    hook({
      tool_use_id: "toolu_sandbox",
      tool_name: "Bash",
      tool_input: { command: "ls", dangerouslyDisableSandbox: true },
    }),
  ];
  for (const request of requests) assert.equal(await requestOnce(unit.runtime, request), "deny");
  assert.deepEqual(correlationMessages(unit.events), [
    "upsert:Claude reused a tool ID with another name",
    "no-input typeof_hook=string",
    'subset toolKeys=["file_path"] hookKeys=["/a"]',
    "dangerouslyDisableSandbox",
  ]);
  assert.equal(turn.requestedToolIds.size, 0, "no refused request is recorded as requested");
});

// Streamed-vs-hook input matching (the subset check and Bash extras) lives in
// claudeApprovalInputMatch.test.ts.
test("an admitted request is withdrawn as deny when the hook aborts", async () => {
  const unit = claudeUnitRuntime();
  const turn = claudeUnitTurn(unit.runtime);
  const controller = new AbortController();
  const decision = requestClaudeApproval(
    unit.runtime,
    hook({ tool_name: "Bash", tool_input: { command: "ls", timeout: 1_000 } }),
    controller.signal,
  );
  assert.equal(unit.runtime.pendingApprovals.size, 1);
  controller.abort();
  assert.equal(await decision, "deny");
  assert.equal(unit.runtime.pendingApprovals.size, 0);
  assert.equal(turn.approvedToolIds.size, 0);
  assert.ok(turn.requestedToolIds.has("toolu_1"), "an aborted request still counts as requested");
});

test("an admitted request resolves once, records allow, and refuses a repeat of its tool ID", async () => {
  const unit = claudeUnitRuntime();
  const turn = claudeUnitTurn(unit.runtime, "turn-1");
  const decision = requestClaudeApproval(unit.runtime, hook(), never);
  const [pending] = [...unit.runtime.pendingApprovals.values()];
  assert.ok(pending);
  const command = {
    type: "resolveInteraction" as const,
    commandId: "command-1",
    hostSessionId: CLAUDE_UNIT.hostSessionId,
    runtimeEpoch: CLAUDE_UNIT.runtimeEpoch,
    turnId: "turn-1",
    interactionId: pending.interactionId,
    decision: "allow" as const,
  };
  assert.throws(
    () => resolveClaudeApproval(unit.runtime, { ...command, runtimeEpoch: "old" }),
    /stale Claude runtime epoch/,
  );
  for (const stale of [{ turnId: "turn-2" }, { interactionId: "unknown" }])
    assert.throws(
      () => resolveClaudeApproval(unit.runtime, { ...command, ...stale }),
      /stale or already resolved/,
    );
  resolveClaudeApproval(unit.runtime, command);
  assert.equal(await decision, "allow");
  assert.ok(turn.approvedToolIds.has("toolu_1"));
  assert.equal(unit.runtime.pendingApprovals.size, 0);
  assert.throws(() => resolveClaudeApproval(unit.runtime, command), /stale or already resolved/);
  assert.equal(await requestClaudeApproval(unit.runtime, hook(), never), "deny");
  assert.deepEqual(correlationMessages(unit.events), ["repeat-tool toolu_1"]);
  assert.deepEqual(eventKinds(unit.events), [
    "tool.started",
    "interaction.requested",
    "interaction.resolved",
    "session.error:claude-approval-correlation",
  ]);
});

test("resolve refuses without an active turn and reports a decision that already has a winner", () => {
  const unit = claudeUnitRuntime();
  const turn = claudeUnitTurn(unit.runtime, "turn-1");
  void claudeUnitPendingApproval(unit.runtime, turn.hostTurnId);
  const pending = unit.runtime.pendingApprovals.get("tool-native-1")!;
  const command = {
    type: "resolveInteraction" as const,
    commandId: "command-1",
    hostSessionId: CLAUDE_UNIT.hostSessionId,
    runtimeEpoch: CLAUDE_UNIT.runtimeEpoch,
    turnId: "turn-1",
    interactionId: "tool-native-1",
    decision: "deny" as const,
  };
  unit.runtime.activeTurn = undefined;
  assert.throws(() => resolveClaudeApproval(unit.runtime, command), /stale or already resolved/);
  unit.runtime.activeTurn = turn;
  pending.decide("allow");
  assert.throws(() => resolveClaudeApproval(unit.runtime, command), /already has a winner/);
});

test("denyPendingClaudeApprovals denies only pending entries and clears the table", async () => {
  const unit = claudeUnitRuntime();
  const turn = claudeUnitTurn(unit.runtime);
  const pending = claudeUnitPendingApproval(unit.runtime, turn.hostTurnId);
  const decided = createClaudeDecision();
  decided.decide("allow");
  unit.runtime.pendingApprovals.set("done", {
    ...unit.runtime.pendingApprovals.get("tool-native-1")!,
    interactionId: "done",
    decision: decided.promise,
    decide: decided.decide,
    state: "resolved",
  });
  denyPendingClaudeApprovals(unit.runtime);
  assert.equal(await pending, "deny");
  assert.equal(await decided.promise, "allow");
  assert.equal(unit.runtime.pendingApprovals.size, 0);
});
