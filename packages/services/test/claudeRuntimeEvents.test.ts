import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "@zcode/shared/agent-host";
import {
  translateClaudeStructuredMessage,
  upsertToolCall,
} from "../src/agent-adapters/claude/claudeRuntimeEvents.js";
import type { ClaudeStructuredMessage } from "../src/agent-adapters/claude/claudeStreamProcess.js";
import { CLAUDE_UNIT, claudeUnitRuntime, claudeUnitTurn } from "./fixtures/claudeUnitFixtures.js";

// Unit coverage for the structured-stream translator: every accepted shape emits the expected
// Host events, and every refused shape reaches `failed` with its own reason and emits nothing.

const SESSION = CLAUDE_UNIT.backendSessionId;

function harness(options: { readonly turn?: boolean } = {}) {
  const { runtime, events } = claudeUnitRuntime();
  if (options.turn !== false) claudeUnitTurn(runtime, "turn-1", false);
  const failures: string[] = [];
  const terminals: Record<string, unknown>[] = [];
  const send = (message: Record<string, unknown>) =>
    translateClaudeStructuredMessage(
      runtime,
      message as ClaudeStructuredMessage,
      (_runtime, _turn, result) => terminals.push(result),
      (_runtime, reason) => failures.push(reason),
    );
  const stream = (event: unknown) => send({ type: "stream_event", event });
  return { runtime, events, failures, terminals, send, stream };
}

function kinds(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.kind);
}

function field(event: AgentEvent | undefined, key: string): unknown {
  return (event as unknown as Record<string, unknown> | undefined)?.[key];
}

test("system init binds only the Host backend session; status and informational subtypes pass", () => {
  const ok = harness({ turn: false });
  ok.send({ type: "system", subtype: "status" });
  ok.send({ type: "system", subtype: "hook_started" });
  assert.equal(ok.runtime.initialized, false);
  ok.send({ type: "system", subtype: "init", session_id: SESSION });
  assert.equal(ok.runtime.initialized, true);
  assert.deepEqual([ok.failures, ok.events], [[], []]);

  const foreign = harness({ turn: false });
  foreign.send({ type: "system", subtype: "init", session_id: "other" });
  foreign.send({ type: "system", subtype: 7 });
  assert.equal(foreign.runtime.initialized, false);
  assert.deepEqual(foreign.failures, [
    "Claude native session ID differs from the Host binding",
    "Claude Code emitted an unsupported system event (7)",
  ]);
});

test("a stopping runtime ignores every message; hook/progress types pass; unknown types fail", () => {
  const stopping = harness();
  stopping.runtime.stopping = true;
  stopping.send({ type: "nonsense" });
  stopping.send({ type: "result", session_id: "other" });
  assert.deepEqual([stopping.failures, stopping.events, stopping.terminals], [[], [], []]);

  const running = harness();
  for (const type of ["hook_started", "hook_progress", "hook_response", "tool_progress"])
    running.send({ type });
  running.send({ type: "nonsense" });
  assert.deepEqual(running.failures, [
    "Claude Code emitted an unsupported structured stream event",
  ]);
});

test("result is terminal only for the bound session and only while a turn is active", () => {
  const bound = harness();
  bound.send({ type: "result", session_id: SESSION, subtype: "success" });
  assert.equal(bound.terminals.length, 1);
  bound.send({ type: "result", session_id: "other" });
  assert.deepEqual(bound.failures, ["Claude result belongs to another native session"]);

  const idle = harness({ turn: false });
  idle.send({ type: "result", session_id: SESSION });
  assert.deepEqual([idle.terminals, idle.failures], [[], []]);
});

test("text streaming needs an active turn and a message_start owner; the turn starts once", () => {
  const idle = harness({ turn: false });
  idle.stream({ type: "ping" });
  assert.deepEqual(idle.failures, ["Claude streamed output outside an active Host turn"]);

  const h = harness();
  h.stream({ type: "ping" });
  h.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } });
  h.stream({ type: "message_start", message: {} });
  assert.deepEqual(h.failures, [
    "Claude text delta has no message owner",
    "Claude message_start is invalid",
  ]);
  h.stream({ type: "message_start", message: { id: "msg-1" } });
  h.stream({ type: "content_block_start", index: 0, content_block: { type: "text" } });
  h.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } });
  h.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "!" } });
  h.stream({ type: "content_block_stop", index: 0 });
  h.stream({ type: "message_delta" });
  h.stream({ type: "message_stop" });
  assert.equal(h.failures.length, 2);
  assert.deepEqual(kinds(h.events), ["turn.started", "text.delta", "text.delta"]);
  assert.deepEqual(
    h.events.slice(1).map((event) => field(event, "text")),
    ["hi", "!"],
  );
  assert.equal(field(h.events[1], "messageId"), field(h.events[2], "messageId"));
});

test("tool_use blocks accumulate partial JSON and refuse incomplete or unowned arguments", () => {
  const h = harness();
  h.stream({ type: "message_start", message: { id: "msg-1" } });
  h.stream({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "Read" },
  });
  h.stream({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"file_path":' },
  });
  const tool = h.runtime.toolCalls.get("toolu_1");
  assert.equal(tool?.input, undefined);
  h.stream({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '"/a"}' },
  });
  h.stream({ type: "content_block_stop", index: 1 });
  assert.deepEqual(tool?.input, { file_path: "/a" });
  assert.deepEqual(kinds(h.events), ["turn.started", "tool.started"]);
  assert.equal(field(h.events[1], "name"), "Read");
  assert.deepEqual(h.failures, []);

  h.stream({
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "toolu_2", name: "Bash" },
  });
  h.stream({
    type: "content_block_delta",
    index: 2,
    delta: { type: "input_json_delta", partial_json: '{"command":' },
  });
  h.stream({ type: "content_block_stop", index: 2 });
  h.stream({
    type: "content_block_delta",
    index: 9,
    delta: { type: "input_json_delta", partial_json: "{}" },
  });
  assert.deepEqual(h.failures, [
    "Claude tool arguments are incomplete",
    "Claude tool input delta has no tool_use owner",
  ]);
});

test("malformed or unsupported stream events each fail with their own reason", () => {
  const h = harness();
  const cases: [unknown, string][] = [
    [
      { type: "content_block_start", index: -1, content_block: { type: "text" } },
      "start is invalid",
    ],
    [{ type: "content_block_start", index: 0 }, "start is invalid"],
    [{ type: "content_block_start", index: 0, content_block: { type: "image" } }, "unsupported"],
    [
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t" } },
      "unsupported",
    ],
    [{ type: "content_block_delta", index: 1.5, delta: {} }, "delta is invalid"],
    [
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta" } },
      "unsupported content delta",
    ],
    [{ type: "content_block_stop" }, "stop is invalid"],
    [{ type: "error" }, "not supported by the pinned adapter"],
    ["not-an-object", "outside an active Host turn"],
  ];
  for (const [event] of cases) h.stream(event);
  assert.equal(h.failures.length, cases.length);
  cases.forEach(([, reason], index) => assert.match(h.failures[index]!, new RegExp(reason)));
  assert.deepEqual(h.events, []);
});

test("assistant messages emit text and tool calls for the bound session only", () => {
  const h = harness();
  h.send({
    type: "assistant",
    session_id: SESSION,
    message: {
      id: "msg-a",
      content: [
        { type: "text", text: "Reading " },
        { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "/x" } },
        { type: "text", text: "now" },
      ],
    },
  });
  assert.deepEqual(kinds(h.events), ["turn.started", "tool.started", "message.finished"]);
  assert.equal(field(h.events[2], "text"), "Reading now");
  assert.equal(field(h.events[2], "role"), "assistant");
  assert.deepEqual(h.runtime.toolCalls.get("toolu_a")?.input, { file_path: "/x" });

  const refused: Record<string, unknown>[] = [
    { session_id: "other", message: { id: "m", content: [] } },
    { session_id: SESSION, message: { id: "m" } },
    { session_id: SESSION, message: { id: "m", content: [null] } },
    { session_id: SESSION, message: { id: "m", content: [{ type: "text", text: 1 }] } },
    { session_id: SESSION, message: { id: "m", content: [{ type: "tool_use", id: "t" }] } },
    { session_id: SESSION, message: { id: "m", content: [{ type: "thinking" }] } },
  ];
  for (const message of refused) h.send({ type: "assistant", ...message });
  assert.deepEqual(h.failures, [
    "Claude assistant message belongs to another native session",
    "Claude assistant message is invalid",
    "Claude assistant content block is invalid",
    "Claude assistant text is invalid",
    "Claude tool_use block is invalid",
    "Claude assistant emitted an unsupported content block",
  ]);
  assert.equal(h.events.length, 3);

  const idle = harness({ turn: false });
  idle.send({ type: "assistant", session_id: SESSION, message: { id: "m", content: [] } });
  assert.deepEqual(idle.failures, [
    "Claude emitted an assistant message outside an active Host turn",
  ]);
});

test("user tool_result messages finish their tool once, with error outcome and capped output", () => {
  const h = harness();
  const turn = h.runtime.activeTurn!;
  upsertToolCall(h.runtime, turn, "toolu_ok", "Read", { file_path: "/x" });
  upsertToolCall(h.runtime, turn, "toolu_err", "Bash", { command: "false" });
  h.send({
    type: "user",
    session_id: SESSION,
    message: {
      role: "user",
      content: [
        { type: "text", text: "visible" },
        { type: "tool_result", tool_use_id: "toolu_ok", content: "x".repeat(40_000) },
        {
          type: "tool_result",
          tool_use_id: "toolu_err",
          is_error: true,
          content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }],
        },
        { type: "tool_result", tool_use_id: "unknown" },
        null,
      ],
    },
  });
  h.send({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ok" }] },
  });
  assert.deepEqual(kinds(h.events), [
    "tool.started",
    "tool.started",
    "message.finished",
    "tool.finished",
    "tool.finished",
  ]);
  assert.equal(field(h.events[2], "role"), "user");
  assert.equal(field(h.events[2], "text"), "visible");
  assert.equal(field(h.events[3], "outcome"), "success");
  assert.equal((field(h.events[3], "outputText") as string).length, 32_000);
  assert.equal(field(h.events[4], "outcome"), "error");
  assert.equal(field(h.events[4], "outputText"), "a\nb");
  assert.deepEqual(h.failures, []);
});

test("user messages without a turn, from another session, or without tool results emit nothing", () => {
  const h = harness();
  upsertToolCall(h.runtime, h.runtime.activeTurn!, "toolu_1", "Read", {});
  const before = h.events.length;
  h.send({ type: "user", session_id: "other", message: { role: "user", content: "hi" } });
  h.send({ type: "user", session_id: SESSION, message: { role: "assistant", content: "hi" } });
  h.send({ type: "user", session_id: SESSION, message: { role: "user", content: "plain" } });
  h.send({ type: "user", session_id: SESSION, message: { role: "user", content: 42 } });
  h.send({
    type: "user",
    session_id: "other",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
  });
  assert.equal(h.events.length, before);
  assert.equal(h.runtime.toolCalls.get("toolu_1")?.finished, false);

  const idle = harness({ turn: false });
  idle.send({ type: "user", message: { role: "user", content: "hi" } });
  assert.deepEqual([idle.events, idle.failures], [[], []]);
});

test("upsertToolCall refuses a reused ID with another name and a repeated Host-turn ID", () => {
  const { runtime, events } = claudeUnitRuntime();
  const turn = claudeUnitTurn(runtime);
  const first = upsertToolCall(runtime, turn, "toolu_1", "Read", undefined);
  assert.equal(first.inputText, "");
  assert.equal(upsertToolCall(runtime, turn, "toolu_1", "Read", { file_path: "/y" }), first);
  assert.deepEqual(first.input, { file_path: "/y" });
  assert.throws(
    () => upsertToolCall(runtime, turn, "toolu_1", "Bash", {}),
    /reused a tool ID with another name/,
  );
  runtime.toolCalls.clear();
  assert.throws(
    () => upsertToolCall(runtime, turn, "toolu_1", "Read", {}),
    /repeated a Host-turn tool ID/,
  );
  assert.deepEqual(kinds(events), ["tool.started"]);
});
