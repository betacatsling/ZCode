import assert from "node:assert/strict";
import test from "node:test";
import type { BindingPlan } from "@zcode/shared/agent-host";
import { validateClaudeModel } from "../src/agent-adapters/claude/claudeBindingGuards.js";
import { translateClaudeStructuredMessage } from "../src/agent-adapters/claude/claudeRuntimeEvents.js";
import type { ClaudeStructuredMessage } from "../src/agent-adapters/claude/claudeStreamProcess.js";
import {
  CLAUDE_UNIT,
  claudeUnitPlan,
  claudeUnitRuntime,
  claudeUnitTurn,
  fakeClaudeModel,
} from "./fixtures/claudeUnitFixtures.js";

// Documentation-only tests: they pin current behaviour that reads as dead or inconsistent code,
// with no source change. Line numbers are for 044b5e0.
//
// Covered elsewhere, listed so the set is complete:
// - Startup on a process that already failed still returns the binding: the early failure is
//   replayed onto the new runtime (claudeSessionStartup.ts:175) and create() resolves with a
//   session.error, then the next turn resumes on a new process. Pinned by
//   claudeSessionStartupFailures.test.ts "a process failure seen before the runtime exists is
//   replayed onto it" ("startup still returns the binding").
// - claudeSessionStartup.ts:186 `if (runtime) ctx.registry.remove(...)` is a no-op: every caller
//   (claudeHarnessAdapter.ts:187 and :225, claudeSessionStartup.ts:216) adds the runtime only
//   after startClaudeSession resolves, reserveStart refuses a session that is already
//   registered, and remove() only deletes the entry it is handed. Not observable from outside,
//   so there is no test for it.
// - The "missing effective selection" plan refusal (claudeBindingGuards.ts:47) is now a typed
//   ClaudeBindingMismatchError("missing-effective"); see claudePlanFixtureBinding.test.ts.

test("documented: validateClaudeModel refuses a missing or unknown effort before startup's own check", () => {
  const plan = claudeUnitPlan();
  const noEffort: BindingPlan = {
    ...plan,
    effective: { ...plan.effective!, options: {} },
  };
  // claudeSessionStartup.ts:76 runs this first, so `if (!effort) throw` at :86-87 cannot fire.
  assert.throws(
    () => validateClaudeModel(noEffort, { ...fakeClaudeModel(), options: {} }),
    /differs from its captured Messages binding or effort/,
  );
  const turbo: BindingPlan = {
    ...plan,
    effective: { ...plan.effective!, options: { reasoningLevel: "turbo" } },
  };
  assert.throws(
    () => validateClaudeModel(turbo, fakeClaudeModel({ reasoningLevel: "turbo" })),
    /or effort/,
  );
  assert.doesNotThrow(() => validateClaudeModel(plan, fakeClaudeModel()));
});

test("documented: runtime.initialized is write-only; output before system init is translated", () => {
  const { runtime, events } = claudeUnitRuntime();
  claudeUnitTurn(runtime, "turn-1", false);
  const failures: string[] = [];
  const send = (message: Record<string, unknown>) =>
    translateClaudeStructuredMessage(
      runtime,
      message as ClaudeStructuredMessage,
      () => undefined,
      (_runtime, reason) => failures.push(reason),
    );
  // Set at claudeRuntimeEvents.ts:58 and initialised at claudeRuntimeEventSink.ts:38; nothing
  // reads it, despite the "Init is enforced above" comment at claudeRuntimeEvents.ts:62-63.
  send({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } });
  send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  });
  assert.equal(runtime.initialized, false);
  assert.deepEqual(failures, []);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["turn.started", "text.delta"],
  );
  send({ type: "system", subtype: "init", session_id: CLAUDE_UNIT.backendSessionId });
  assert.equal(runtime.initialized, true);
  assert.equal(events.length, 2, "init changes nothing observable");
});
