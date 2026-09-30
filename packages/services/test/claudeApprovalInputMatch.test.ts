import assert from "node:assert/strict";
import test from "node:test";
import type { ClaudePreToolUseInput } from "../src/agent-adapters/claude/claudeApprovalHookServer.js";
import {
  denyPendingClaudeApprovals,
  requestClaudeApproval,
} from "../src/agent-adapters/claude/claudeHostApproval.js";
import { upsertToolCall } from "../src/agent-adapters/claude/claudeRuntimeEvents.js";
import { CLAUDE_UNIT, claudeUnitRuntime, claudeUnitTurn } from "./fixtures/claudeUnitFixtures.js";

// PreToolUse must match the tool input Claude already streamed for the same tool_use_id: every
// streamed key must appear unchanged in the hook input, and only Bash may add bounded
// description/timeout and false run_in_background/dangerouslyDisableSandbox keys. The hook's
// own upsert must not overwrite the streamed input before the comparison. With no streamed input
// yet (the hook can arrive first), the hook input seeds the tool call and is what gets approved.

type Outcome = "admitted" | { readonly denied: string };

async function approve(
  name: string,
  streamed: Record<string, unknown> | "absent" | "partial",
  hookInput: unknown,
): Promise<{ readonly outcome: Outcome; readonly toolInput: unknown }> {
  const unit = claudeUnitRuntime();
  const turn = claudeUnitTurn(unit.runtime);
  if (streamed === "partial") {
    const tool = upsertToolCall(unit.runtime, turn, "toolu_1", name, undefined);
    tool.inputText = '{"command":';
  } else if (streamed !== "absent") {
    upsertToolCall(unit.runtime, turn, "toolu_1", name, streamed);
  }
  const decision = requestClaudeApproval(
    unit.runtime,
    {
      hook_event_name: "PreToolUse",
      session_id: CLAUDE_UNIT.backendSessionId,
      tool_name: name,
      tool_use_id: "toolu_1",
      tool_input: hookInput,
    } satisfies ClaudePreToolUseInput,
    new AbortController().signal,
  );
  const admitted = unit.runtime.pendingApprovals.size === 1;
  denyPendingClaudeApprovals(unit.runtime);
  await decision;
  const error = unit.events.find((event) => event.kind === "session.error");
  const toolInput = unit.runtime.toolCalls.get("toolu_1")?.input;
  if (admitted) return { outcome: "admitted", toolInput };
  assert.ok(error?.kind === "session.error", "a refusal reports a correlation error");
  return { outcome: { denied: error.message.replace(/^.*\((.*)\)$/, "$1") }, toolInput };
}

function assertDenied(outcome: Outcome, reason: RegExp, label: string): void {
  assert.notEqual(outcome, "admitted", `${label} must be refused`);
  assert.match((outcome as { denied: string }).denied, reason, label);
}

test("a hook input that differs from the streamed input is refused", async () => {
  const cases: [string, Record<string, unknown>, unknown][] = [
    ["Read", { file_path: "/a" }, { file_path: "/b" }],
    ["Read", { file_path: "/a" }, { file_path: "/a", offset: 1 }],
    ["Read", { file_path: "/a", limit: 5 }, { file_path: "/a" }],
    ["Bash", { command: "ls" }, { command: "rm -rf /" }],
    ["Bash", { command: "ls", description: "list" }, { command: "ls" }],
  ];
  for (const [name, streamed, hookInput] of cases) {
    const { outcome, toolInput } = await approve(name, streamed, hookInput);
    const label = `${name} ${JSON.stringify(streamed)} -> ${JSON.stringify(hookInput)}`;
    assertDenied(outcome, /^subset toolKeys=/, label);
    assert.deepEqual(toolInput, streamed, `${label}: the streamed input is kept`);
  }
});

test("Bash extra keys outside the bounded allow-list are refused", async () => {
  const refused: Record<string, unknown>[] = [
    { timeout: 0 },
    { timeout: 300_001 },
    { timeout: 1.5 },
    { timeout: "1000" },
    { description: 7 },
    { description: "x".repeat(16_001) },
    { run_in_background: true },
    { dangerouslyDisableSandbox: true },
    { cwd: "/" },
  ];
  for (const extra of refused) {
    const { outcome } = await approve("Bash", { command: "ls" }, { command: "ls", ...extra });
    assertDenied(outcome, /^subset toolKeys=\["command"\]/, `Bash extra ${JSON.stringify(extra)}`);
  }
});

test("allow-listed Bash extras pass and the approved input is the hook input", async () => {
  const hookInput = {
    command: "ls",
    description: "x".repeat(16_000),
    timeout: 300_000,
    run_in_background: false,
    dangerouslyDisableSandbox: false,
  };
  const { outcome, toolInput } = await approve("Bash", { command: "ls" }, hookInput);
  assert.equal(outcome, "admitted");
  assert.deepEqual(toolInput, hookInput);
  const reordered = await approve(
    "Read",
    { file_path: "/a", limit: 5 },
    { limit: 5, file_path: "/a" },
  );
  assert.equal(reordered.outcome, "admitted", "key order does not matter");
});

test("dangerouslyDisableSandbox is refused even when the streamed input also carries it", async () => {
  const input = { command: "ls", dangerouslyDisableSandbox: true };
  const streamedToo = await approve("Bash", input, input);
  assertDenied(streamedToo.outcome, /^dangerouslyDisableSandbox$/, "streamed and hook sandbox off");
  const hookOnly = await approve("Bash", "absent", input);
  assertDenied(hookOnly.outcome, /^dangerouslyDisableSandbox$/, "hook-seeded sandbox off");
});

test("with no complete streamed input the hook input seeds the tool call (unchanged behaviour)", async () => {
  for (const streamed of ["absent", "partial"] as const) {
    const hookInput = { command: "ls", cwd: "/" };
    const { outcome, toolInput } = await approve("Bash", streamed, hookInput);
    assert.equal(outcome, "admitted", `${streamed}: nothing streamed to compare against`);
    assert.deepEqual(toolInput, hookInput);
  }
  const notObject = await approve("Read", "absent", "not-an-object");
  assertDenied(notObject.outcome, /^no-input typeof_hook=string$/, "non-object hook input");
  const arrayVsStreamed = await approve("Read", { file_path: "/a" }, ["/a"]);
  assertDenied(
    arrayVsStreamed.outcome,
    /^subset toolKeys=\["file_path"\] hookKeys=\["\/a"\]$/,
    "array",
  );
});
