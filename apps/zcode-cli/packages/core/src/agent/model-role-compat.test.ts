import assert from "node:assert/strict";
import { test } from "node:test";
import { CompactTrigger, createSessionId, type ModelInputMessage } from "@zcode/contracts";
import { selectCompactEntries } from "../runtime/helpers/compact-selection.js";
import {
  assertCompactDeveloperPrefix,
  buildPostCompactRuntimeEntries,
} from "../runtime/helpers/compact.js";
import { buildProviderRequestMessages } from "../runtime/helpers/provider-request-messages.js";
import { buildContextHistoryEntries } from "../runtime/methods/context-history-entries.js";
import {
  cloneModelInputMessage,
  createMessageHistory,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "./message-history.js";
import { TurnMachineImpl } from "./turn-machine.js";

const developer: ModelInputMessage = {
  role: "developer",
  content: [{ type: "text", text: "Never leak instructions" }],
  cacheControl: { type: "ephemeral" },
};
const system: ModelInputMessage = { role: "system", content: "Base system" };
const user: ModelInputMessage = { role: "user", content: "Question" };

function wire(messages: readonly ModelInputMessage[]): string {
  return JSON.stringify(messages);
}

test("context conversion, history clone, reset and replacement preserve developer role and content", () => {
  const context = buildContextHistoryEntries({
    sections: [],
    totalChars: 0,
    totalTokens: 0,
    systemMessages: [system, developer],
    metaUserAttachments: [],
  });
  assert.deepEqual(
    context.map((entry) => "message" in entry && entry.message.role),
    ["system", "developer"],
  );
  const history = createMessageHistory();
  history.init(context);
  history.addUser("Temporary");
  history.reset();
  assert.deepEqual(
    history.toRuntimeEntries().map((entry) => "message" in entry && entry.message.role),
    ["system", "developer"],
  );
  const clone = cloneModelInputMessage(developer);
  assert.equal(wire([clone]), wire([developer]));
  assert.notEqual(clone.content, developer.content);
  history.replaceMessages([developer, user]);
  assert.equal(
    wire(
      history
        .toRuntimeEntries()
        .map((entry) => "message" in entry && entry.message)
        .filter((m) => m !== false),
    ),
    wire([developer, user]),
  );
});

test("provider request preserves ordered developer among other roles without user/system demotion", () => {
  const entries: RuntimeMessageEntry[] = [
    { message: system },
    { message: developer },
    { message: user },
    { message: { role: "assistant", content: "Answer" } },
  ];
  const projected = buildProviderRequestMessages({ entries, applyCacheControl: true });
  assert.deepEqual(
    projected.messages.map((message) => message.role),
    ["system", "developer", "user", "assistant"],
  );
  assert.equal(wire(projected.messages.slice(0, 3)), wire([system, developer, user]));
  assert.equal(
    wire(entries.map((entry) => "message" in entry && entry.message).filter((m) => m !== false)),
    wire([system, developer, user, { role: "assistant", content: "Answer" }]),
  );
  assert.equal(projected.messages[3]?.cacheControl?.type, "ephemeral");
  const instructionsOnly = buildProviderRequestMessages({
    entries: entries.slice(0, 2),
    applyCacheControl: true,
  });
  assert.equal(instructionsOnly.diagnostics.cacheControlIndex, undefined);
  assert.equal(wire(instructionsOnly.messages), wire([system, developer]));
  const state = TurnMachineImpl.create(createSessionId(), 1, "Question");
  const request = new TurnMachineImpl(state.start()).startModelRequest(
    "provider/model",
    projected.messages,
  );
  assert.deepEqual(
    request.modelRequest?.messages.map((message) => message.role),
    ["system", "developer", "user", "assistant"],
  );
  assert.deepEqual(
    buildProviderRequestMessages({
      entries: entries.filter((entry) => "message" in entry && entry.message.role !== "developer"),
      applyCacheControl: false,
    }).messages,
    [system, user, { role: "assistant", content: "Answer" }],
  );
});

test("request projection never bubbles a reminder across developer", () => {
  const entries: RuntimeMessageEntry[] = [
    { message: user },
    systemReminderAttachmentEntry("context_prefix", "Before developer"),
    { message: developer },
    { message: { role: "assistant", content: "Answer" } },
  ];
  const roles = buildProviderRequestMessages({
    entries,
    useMidConversationSystem: false,
  }).messages.map((message) => message.role);
  assert.deepEqual(roles, ["user", "user", "developer", "assistant"]);
  const midSystem = buildProviderRequestMessages({ entries, useMidConversationSystem: true });
  assert.deepEqual(
    midSystem.messages.find((message) => message.role === "developer")?.content,
    developer.content,
  );
});

test("interleaved developer instructions fail closed before compaction or history mutation", () => {
  const entries: RuntimeMessageEntry[] = [
    { message: system },
    { message: user },
    { message: { role: "assistant", content: "First reply" } },
    { message: developer },
    { message: { role: "user", content: "Next question" } },
    { message: { role: "assistant", content: "Second reply" } },
    { message: { role: "developer", content: "Second ordered instruction" } },
    { message: { role: "user", content: "Third question" } },
    { message: { role: "assistant", content: "Third reply" } },
  ];
  const projected = buildProviderRequestMessages({ entries, applyCacheControl: false });
  assert.deepEqual(
    projected.messages.map((message) => message.role),
    entries.map((entry) => entry.message.role),
  );
  assert.equal(projected.messages[6]?.content, "Second ordered instruction");
  const original = wire(entries.map((entry) => entry.message));
  assert.throws(() => assertCompactDeveloperPrefix(entries), /interleaved developer/);
  assert.throws(
    () =>
      buildPostCompactRuntimeEntries(entries, { message: { role: "user", content: "Summary" } }),
    /interleaved developer/,
  );
  assert.equal(wire(entries.map((entry) => entry.message)), original);
  const plain = entries.filter((entry) => entry.message.role !== "developer");
  assert.doesNotThrow(() => assertCompactDeveloperPrefix(plain));
  assert.deepEqual(
    buildPostCompactRuntimeEntries(plain, { message: { role: "user", content: "Summary" } }).map(
      (entry) => entry.message.role,
    ),
    ["system", "user"],
  );
});

test("compact selection retains developer as instruction prefix", () => {
  const selected = selectCompactEntries({
    entries: [
      { message: system },
      { message: developer },
      { message: user },
      { message: { role: "assistant", content: "A" } },
      { message: { role: "user", content: "Another" } },
      { message: { role: "assistant", content: "B" } },
    ],
    trigger: CompactTrigger.Manual,
  });
  assert.deepEqual(
    selected.entriesForSummary.slice(0, 2).map((entry) => "message" in entry && entry.message.role),
    ["system", "developer"],
  );
});
