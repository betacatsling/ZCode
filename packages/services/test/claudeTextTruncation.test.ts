import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@zcode/shared/agent-host";
import { requestClaudeApproval } from "../src/agent-adapters/claude/claudeHostApproval.js";
import { markClaudeTurnUnknown } from "../src/agent-adapters/claude/claudeRuntimeOutcome.js";
import {
  SESSION_ERROR_MESSAGE_MAX,
  truncateCodePointSafe,
} from "../src/agent-adapters/claude/claudeText.js";
import { CLAUDE_UNIT, claudeUnitRuntime, claudeUnitTurn } from "./fixtures/claudeUnitFixtures.js";

// Capped Claude event text (session.error message: schema max 1024 UTF-16 units; approval
// summary: 2000) must never end in half of a surrogate pair when an emoji or other astral
// character straddles the cap.

const EMOJI = "\u{1F600}"; // one code point, two UTF-16 units
const SESSION_ERROR_MAX = 1024;
const APPROVAL_PREFIX =
  "Claude requested a stale, repeated or mismatched tool approval. (session-mismatch hook=";

function sessionErrors(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => (event.kind === "session.error" ? [event.message] : []));
}

test("markClaudeTurnUnknown drops an emoji that straddles the 1024-unit cap instead of splitting it", () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  markClaudeTurnUnknown(runtime, turn, `${"a".repeat(SESSION_ERROR_MAX - 1)}${EMOJI}tail`);
  const [message] = sessionErrors(events);
  assert.ok(message!.isWellFormed(), "no lone surrogate half at the cut");
  assert.equal(message, "a".repeat(SESSION_ERROR_MAX - 1));
});

test("markClaudeTurnUnknown keeps an emoji that ends exactly at the cap", () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  const exact = `${"a".repeat(SESSION_ERROR_MAX - 2)}${EMOJI}`;
  markClaudeTurnUnknown(runtime, turn, `${exact}tail`);
  assert.deepEqual(sessionErrors(events), [exact]);
});

test("an approval correlation denial with an oversized detail is capped whole, not thrown", async () => {
  const { runtime, events } = claudeUnitRuntime();
  claudeUnitTurn(runtime);
  // The cap lands on the high half of the first emoji of the hook's session id.
  const kept = "s".repeat(SESSION_ERROR_MAX - 1 - APPROVAL_PREFIX.length);
  const decision = await requestClaudeApproval(
    runtime,
    {
      hook_event_name: "PreToolUse",
      session_id: `${kept}${EMOJI.repeat(20)}`,
      tool_name: "Read",
      tool_use_id: "tool-oversized-detail",
      tool_input: { file_path: "/tmp/x" },
    },
    new AbortController().signal,
  );
  assert.equal(decision, "deny");
  const [message] = sessionErrors(events);
  assert.ok(message!.length <= SESSION_ERROR_MAX, `message length ${message!.length}`);
  assert.ok(message!.isWellFormed(), "no lone surrogate half at the cut");
  assert.equal(message, `${APPROVAL_PREFIX}${kept}`);
});

test("an approval summary cuts its tool input JSON at 2000 units without splitting a surrogate pair", async () => {
  const { runtime, events } = claudeUnitRuntime();
  claudeUnitTurn(runtime);
  // summary = "<tool>: " + JSON.stringify(tool_input) capped at 2000; JSON unit 2000 is the high
  // half of the first emoji.
  const jsonPrefix = '{"file_path":"';
  const kept = "p".repeat(1999 - jsonPrefix.length);
  const controller = new AbortController();
  const pending = requestClaudeApproval(
    runtime,
    {
      hook_event_name: "PreToolUse",
      session_id: CLAUDE_UNIT.backendSessionId,
      tool_name: "Read",
      tool_use_id: "tool-long-summary",
      tool_input: { file_path: `${kept}${EMOJI.repeat(20)}` },
    },
    controller.signal,
  );
  const requested = events.find((event) => event.kind === "interaction.requested");
  controller.abort();
  assert.equal(await pending, "deny", "the aborted hook denies");
  assert.ok(requested?.kind === "interaction.requested");
  assert.ok(
    requested.summary.length <= "Read: ".length + 2_000,
    `length ${requested.summary.length}`,
  );
  assert.ok(requested.summary.isWellFormed(), "no lone surrogate half at the cut");
  assert.equal(requested.summary, `Read: ${jsonPrefix}${kept}`);
});

test("truncateCodePointSafe caps by UTF-16 units and never leaves a lone surrogate half", () => {
  assert.equal(truncateCodePointSafe("short", 10), "short", "within the cap: unchanged");
  assert.equal(truncateCodePointSafe("abcdef", 3), "abc");
  assert.equal(truncateCodePointSafe("abcdef", 0), "");
  assert.equal(truncateCodePointSafe("é中文x", 3), "é中文", "BMP characters are one unit each");
  // Every cut through a run of astral characters stays well formed and within the cap.
  const astral = `a${EMOJI}${"\u{20BB7}"}${EMOJI}b`; // a + 3 pairs + b = 8 units
  for (let cap = 0; cap <= astral.length; cap += 1) {
    const cut = truncateCodePointSafe(astral, cap);
    assert.ok(cut.length <= cap, `cap ${cap}: length ${cut.length}`);
    assert.ok(cut.length >= cap - 1, `cap ${cap}: drops at most one unit`);
    assert.ok(cut.isWellFormed(), `cap ${cap}: well formed`);
    assert.ok(astral.startsWith(cut), `cap ${cap}: a prefix`);
  }
  assert.equal(
    truncateCodePointSafe(`${EMOJI}${EMOJI}`, 3),
    EMOJI,
    "pair at the cap is dropped whole",
  );
  assert.equal(truncateCodePointSafe(`${EMOJI}${EMOJI}`, 1), "");
  assert.equal(SESSION_ERROR_MESSAGE_MAX, 1024);
});
