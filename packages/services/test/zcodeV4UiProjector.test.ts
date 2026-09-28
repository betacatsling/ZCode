import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { AgentEvent, CompatibleSessionSpec } from "@zcode/shared/agent-host";
import {
  applyConversationDeltas,
  commandAckSchema,
  conversationSnapshotSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  sessionsIndexTopic,
  sessionsIndexTopicFrameSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { projectHostConversation } from "../src/agent-ui-projection/projector.js";
import {
  applyProjectedConversationFrame,
  projectConversationDelivery,
} from "../src/agent-ui-projection/zcodeV4Projector.js";
import { createConversationPublisher } from "../src/agent-ui-projection/conversationPublisher.js";
import { createSessionsIndexPublisher } from "../src/agent-ui-projection/sessionsIndexPublisher.js";
import { translateV4Command } from "../src/agent-ui-projection/commandTranslator.js";

const epoch = randomUUID();
const spec: CompatibleSessionSpec = {
  schemaVersion: 2,
  hostSessionId: "host-1",
  projectId: "project-1",
  workspaceId: "workspace-1",
  execution: {
    targetId: "local-1",
    workspaceIdentity: "workspace-identity",
    worktreePath: "/tmp/test",
    worktreeGeneration: "gen-1",
    cwdRelativeToWorktree: ".",
  },
  harness: { id: "pi", adapterVersion: "0.87.1" },
  modelBinding: {
    kind: "host-managed",
    selection: { providerId: "provider-a", modelId: "model-a" },
  },
};

function event(sequence: number, kind: AgentEvent["kind"], rest: Record<string, unknown>): AgentEvent {
  return {
    hostSessionId: spec.hostSessionId,
    runtimeEpoch: epoch,
    sequence,
    eventId: `evt-${sequence}`,
    at: sequence * 1000,
    kind,
    ...rest,
  } as AgentEvent;
}

const topic = conversationTopic(spec.hostSessionId);
const subscriptionId = "sub-1";

function deliver(
  events: readonly AgentEvent[],
  base?: { logEpoch: string; seq: number },
  clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
  windowSize?: number,
) {
  return projectConversationDelivery({
    spec,
    runtimeEpoch: epoch,
    events,
    topic,
    subscriptionId,
    clientMode,
    ...(base ? { base } : {}),
    ...(windowSize ? { windowSize } : {}),
    now: 50,
  });
}

function assertSnapshotFrame(frame: ConversationTopicFrame, events: readonly AgentEvent[]) {
  assert.deepEqual(conversationTopicFrameSchema.parse(frame), frame);
  assert.equal(frame.fromSeq, 0);
  assert.equal(frame.payload.kind, "snapshot");
  if (frame.payload.kind !== "snapshot") return;
  assert.equal(frame.toSeq, frame.payload.snapshot.seq);
  assert.deepEqual(
    frame.payload.snapshot,
    projectHostConversation({ spec, runtimeEpoch: epoch, events }),
  );
}

test("snapshot replaces the whole conversation and keeps unsupported actions unavailable", () => {
  const events = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "message.finished", {
      turnId: "turn-1",
      messageId: "user-1",
      role: "user",
      text: "hi",
    }),
  ];
  const delivery = deliver(events);
  assert.equal(delivery.mode, "snapshot");
  assert.equal(delivery.reason, "initial");
  if (delivery.mode !== "snapshot") return;
  assertSnapshotFrame(delivery.frame, events);
  const stale: ConversationSnapshot = {
    ...delivery.frame.payload.snapshot,
    meta: { title: "stale-local", titleSource: "custom" },
  };
  const replaced = applyProjectedConversationFrame(stale, delivery.frame);
  assert.equal(replaced.meta.title, "");
  assert.deepEqual(replaced, delivery.frame.payload.snapshot);
  for (const action of Object.values(replaced.availability)) {
    assert.equal(action.allowed, false);
    if (!action.allowed) assert.equal(action.reasonCode, "externalHarnessUnsupported");
  }
});

test("deltas stay contiguous and terminal text replaces streamed text once", () => {
  const events = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "hel" }),
    event(3, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "lo" }),
    event(4, "message.finished", {
      turnId: "turn-1",
      messageId: "message-1",
      role: "assistant",
      text: "hello",
    }),
  ];
  const opened = deliver(events.slice(0, 2));
  assert.equal(opened.mode, "snapshot");
  if (opened.mode !== "snapshot") return;
  const continued = deliver(events, { logEpoch: epoch, seq: opened.frame.toSeq });
  assert.equal(continued.mode, "resume");
  assert.equal(continued.reason, "deltas");
  if (continued.mode !== "resume" || continued.reason !== "deltas") return;
  assert.equal(continued.frame.fromSeq, opened.frame.toSeq);
  assert.equal(continued.frame.toSeq, 4);
  assert.equal(continued.frame.payload.kind, "deltas");
  const applied = applyProjectedConversationFrame(
    opened.frame.payload.snapshot,
    continued.frame,
  );
  const head = projectHostConversation({ spec, runtimeEpoch: epoch, events });
  assert.deepEqual(applied, head);
  const row = applied.rows.window.find((item) => item.kind === "assistantText");
  assert.equal(row?.kind === "assistantText" && row.text, "hello");
  assert.equal(applied.rows.window.filter((item) => item.kind === "assistantText").length, 1);
  const streamed = applyConversationDeltas(
    opened.frame.payload.snapshot,
    continued.frame.payload.kind === "deltas" ? continued.frame.payload.deltas : [],
  );
  const assistant = streamed.rows.window.find((item) => item.kind === "assistantText");
  assert.equal(assistant?.kind === "assistantText" && assistant.text, "hello");
});

test("desktop continuous and web replayable share one sequence and resubscribe across gaps", () => {
  const events = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "a" }),
    event(3, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "b" }),
  ];
  const base = { logEpoch: epoch, seq: 1 };
  const desktop = deliver(events, base, "desktop-continuous");
  const mobile = deliver(events, base, "web-remote-replayable");
  assert.equal(desktop.mode, "resume");
  assert.equal(mobile.mode, "resume");
  if (desktop.mode !== "resume" || desktop.reason !== "deltas") return;
  if (mobile.mode !== "resume" || mobile.reason !== "deltas") return;
  assert.equal(desktop.frame.fromSeq, mobile.frame.fromSeq);
  assert.equal(desktop.frame.toSeq, mobile.frame.toSeq);
  assert.deepEqual(desktop.frame.payload, mobile.frame.payload);

  const ahead = deliver(events, { logEpoch: epoch, seq: 9 });
  assert.equal(ahead.mode, "snapshot");
  assert.equal(ahead.reason, "cursor-gap");
  if (ahead.mode !== "snapshot") return;
  assert.equal(ahead.frame.fromSeq, 0);
  assert.equal(ahead.frame.payload.kind, "snapshot");

  const otherEpoch = deliver(events, { logEpoch: "other-epoch", seq: 1 });
  assert.equal(otherEpoch.mode, "snapshot");
  assert.equal(otherEpoch.reason, "epoch-changed");

  const hole = deliver([
    event(1, "turn.started", { turnId: "turn-1" }),
    event(3, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "x" }),
  ]);
  assert.equal(hole.mode, "resync");
  assert.equal(hole.reason, "sequence-gap");
  assert.equal("frame" in hole && hole.frame, false);
});

test("a window eviction cannot be expressed as a delta and becomes a snapshot", () => {
  const events = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "message.finished", {
      turnId: "turn-1",
      messageId: "user-1",
      role: "user",
      text: "one",
    }),
    event(3, "message.finished", {
      turnId: "turn-1",
      messageId: "assistant-1",
      role: "assistant",
      text: "two",
    }),
  ];
  const delivery = deliver(events, { logEpoch: epoch, seq: 2 }, "web-remote-replayable", 1);
  assert.equal(delivery.mode, "snapshot");
  assert.equal(delivery.reason, "not-expressible");
  if (delivery.mode !== "snapshot") return;
  assert.equal(delivery.frame.fromSeq, 0);
  assert.equal(delivery.frame.payload.kind, "snapshot");
});

test("publisher remembers the delivered watermark and does not skip a repaired gap", () => {
  const publisher = createConversationPublisher({
    spec,
    runtimeEpoch: epoch,
    topic,
    subscriptionId,
    clientMode: "desktop-continuous",
    now: () => 50,
  });
  const first = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "a" }),
  ];
  const opened = publisher.open(first);
  assert.equal(opened.mode, "snapshot");
  if (opened.mode !== "snapshot") return;
  const gapped = publisher.push([
    ...first,
    event(4, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "c" }),
  ]);
  assert.equal(gapped.mode, "resync");
  const repaired = publisher.push([
    ...first,
    event(3, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "b" }),
  ]);
  assert.equal(repaired.mode, "resume");
  if (repaired.mode !== "resume" || repaired.reason !== "deltas") return;
  assert.equal(repaired.frame.fromSeq, opened.frame.toSeq);
  assert.equal(repaired.frame.toSeq, 3);
  const applied = applyProjectedConversationFrame(opened.frame.payload.snapshot, repaired.frame);
  assert.equal(applied.seq, 3);
});

test("plan, subagent, file path, error text and inert extensions stay visible", () => {
  const longPlan = "plan ".repeat(40);
  const events = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "plan.updated", { turnId: "turn-1", text: "first plan" }),
    event(3, "plan.updated", { turnId: "turn-1", text: longPlan }),
    event(4, "tool.started", {
      turnId: "turn-1",
      toolCallId: "tool-1",
      name: "write",
      inputText: '{"path":',
    }),
    event(5, "file.changed", {
      turnId: "turn-1",
      toolCallId: "tool-1",
      name: "write",
      path: "src/a.ts",
      additions: 2,
      deletions: 1,
    }),
    event(6, "file.changed", {
      turnId: "turn-1",
      toolCallId: "tool-1",
      name: "write",
      path: "src/b.ts",
      additions: 4,
      deletions: 0,
    }),
    event(7, "tool.finished", {
      turnId: "turn-1",
      toolCallId: "tool-1",
      name: "write",
      outcome: "success",
      outputText: "wrote",
    }),
    event(8, "subagent.updated", {
      turnId: "turn-1",
      childSessionId: "child-1",
      status: "started",
    }),
    event(9, "subagent.updated", {
      turnId: "turn-1",
      childSessionId: "child-1",
      status: "finished",
    }),
    event(10, "extension.event", {
      namespace: "acme.tools",
      version: 2,
      payload: { exec: "do-not-run", token: "secret-looking" },
    }),
    event(11, "session.error", { code: "backend-down", message: "harness stopped" }),
    event(12, "tool.started", {
      turnId: "turn-1",
      toolCallId: "tool-2",
      name: "read",
      inputText: '{"path":"README.md"}',
    }),
    event(13, "tool.finished", {
      turnId: "turn-1",
      toolCallId: "tool-2",
      name: "read",
      outcome: "success",
      outputText: "ok",
    }),
  ];
  const snapshot = conversationSnapshotSchema.parse(
    projectHostConversation({ spec, runtimeEpoch: epoch, events }),
  );
  assert.equal(snapshot.plan?.items.length, 1);
  assert.equal(snapshot.plan?.items[0]?.content, longPlan);
  assert.equal(snapshot.plan?.items[0]?.id, "evt-3");
  const write = snapshot.rows.window.find(
    (row) => row.kind === "toolCall" && row.toolCallId === "tool-1",
  );
  assert.equal(write?.kind, "toolCall");
  if (write?.kind !== "toolCall") return;
  assert.equal(write.input, undefined);
  assert.match(write.output?.text ?? "", /src\/a\.ts/);
  assert.match(write.output?.text ?? "", /src\/b\.ts/);
  assert.match(write.output?.text ?? "", /wrote/);
  assert.equal(write.output?.display && "filePath" in write.output.display && write.output.display.filePath, "src/b.ts");
  const read = snapshot.rows.window.find(
    (row) => row.kind === "toolCall" && row.toolCallId === "tool-2",
  );
  assert.equal(read?.kind, "toolCall");
  if (read?.kind !== "toolCall") return;
  assert.deepEqual(read.input, { path: "README.md" });
  const child = snapshot.rows.window.find((row) => row.kind === "subagent");
  assert.equal(child?.kind, "subagent");
  if (child?.kind !== "subagent") return;
  assert.equal(child.childSessionId, "child-1");
  assert.equal(child.status, "success");
  assert.equal(child.subagentType, "unknown");
  assert.deepEqual(snapshot.subagents?.childSessionIds, ["child-1"]);
  assert.equal(snapshot.subagents?.running.length, 0);
  assert.equal(snapshot.subagents?.endedTotal, 1);
  const extension = snapshot.rows.window.find(
    (row) => row.kind === "toolCall" && row.toolCallId === "evt-10",
  );
  assert.equal(extension?.kind, "toolCall");
  if (extension?.kind !== "toolCall") return;
  assert.equal(extension.status, "error");
  assert.equal(extension.error?.code, "extension-ui-unsupported");
  assert.equal(extension.input, undefined);
  assert.equal(extension.toolName, "acme.tools");
  assert.match(extension.output?.text ?? "", /v2/);
  assert.match(extension.output?.text ?? "", /do-not-run/);
  assert.equal(snapshot.control.lastError?.code, "backend-down");
  assert.equal(snapshot.control.lastError?.message, "harness stopped");
});

test("sessions index snapshot replaces and deltas stay contiguous", () => {
  const publisher = createSessionsIndexPublisher({
    workspaceId: "workspace-1",
    logEpoch: "index-epoch",
    topic: sessionsIndexTopic("workspace-1"),
    subscriptionId: "index-sub",
    now: () => 80,
  });
  const running = [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "text.delta", { turnId: "turn-1", messageId: "message-1", text: "x".repeat(200) }),
    event(3, "tool.started", { turnId: "turn-1", toolCallId: "tool-1", name: "write" }),
    event(4, "interaction.requested", {
      turnId: "turn-1",
      interactionId: "approval-1",
      toolCallId: "tool-1",
      summary: "Write file?",
    }),
  ];
  const opened = publisher.publish({
    clientMode: "web-remote-replayable",
    sessions: [{ spec, runtimeEpoch: epoch, events: running }],
  });
  assert.equal(opened.mode, "snapshot");
  if (opened.mode !== "snapshot") return;
  assert.deepEqual(sessionsIndexTopicFrameSchema.parse(opened.frame), opened.frame);
  assert.equal(opened.frame.fromSeq, 0);
  assert.equal(opened.frame.payload.kind, "snapshot");
  if (opened.frame.payload.kind !== "snapshot") return;
  const summary = opened.frame.payload.snapshot.sessions[0];
  assert.equal(summary?.sessionId, spec.hostSessionId);
  assert.equal(summary?.workspaceId, "workspace-1");
  assert.equal(summary?.agentHost?.harnessId, "pi");
  assert.equal(summary?.phase, "running");
  assert.equal(summary?.pendingInteractionSummary?.permissionCount, 1);
  assert.equal(summary?.pendingInteraction?.interactionId, "approval-1");
  assert.equal(summary?.pendingInteraction?.toolName, "write");
  assert.equal(summary?.lastAssistantPreview?.length, 120);
  const replayable = publisher.publish({
    clientMode: "web-remote-replayable",
    base: { logEpoch: "index-epoch", seq: opened.frame.toSeq },
    sessions: [
      {
        spec,
        runtimeEpoch: epoch,
        events: [
          ...running,
          event(5, "interaction.resolved", {
            turnId: "turn-1",
            interactionId: "approval-1",
            decision: "deny",
          }),
        ],
      },
    ],
  });
  const continuous = createSessionsIndexPublisher({
    workspaceId: "workspace-1",
    logEpoch: "index-epoch",
    topic: sessionsIndexTopic("workspace-1"),
    subscriptionId: "index-sub",
    now: () => 80,
  });
  continuous.publish({
    clientMode: "desktop-continuous",
    sessions: [{ spec, runtimeEpoch: epoch, events: running }],
  });
  const desktop = continuous.publish({
    clientMode: "desktop-continuous",
    base: { logEpoch: "index-epoch", seq: opened.frame.toSeq },
    sessions: [
      {
        spec,
        runtimeEpoch: epoch,
        events: [
          ...running,
          event(5, "interaction.resolved", {
            turnId: "turn-1",
            interactionId: "approval-1",
            decision: "deny",
          }),
        ],
      },
    ],
  });
  assert.equal(replayable.mode, "resume");
  assert.equal(desktop.mode, "resume");
  if (replayable.mode !== "resume" || replayable.reason !== "deltas") return;
  if (desktop.mode !== "resume" || desktop.reason !== "deltas") return;
  assert.equal(replayable.frame.fromSeq, opened.frame.toSeq);
  assert.equal(replayable.frame.toSeq, desktop.frame.toSeq);
  assert.deepEqual(replayable.frame.payload, desktop.frame.payload);
  const removed = publisher.publish({
    clientMode: "desktop-continuous",
    base: { logEpoch: "index-epoch", seq: replayable.frame.toSeq },
    sessions: [],
  });
  assert.equal(removed.mode, "resume");
  if (removed.mode !== "resume" || removed.reason !== "deltas") return;
  assert.equal(removed.frame.payload.kind, "deltas");
  if (removed.frame.payload.kind !== "deltas") return;
  assert.equal(removed.frame.payload.deltas[0]?.op, "session.removed");
  const ahead = publisher.publish({
    clientMode: "web-remote-replayable",
    base: { logEpoch: "index-epoch", seq: 99 },
    sessions: [],
  });
  assert.equal(ahead.mode, "snapshot");
  assert.equal(ahead.reason, "cursor-gap");
  if (ahead.mode !== "snapshot") return;
  assert.equal(ahead.frame.fromSeq, 0);
});

test("a gapped session log does not drop the index row", () => {
  const publisher = createSessionsIndexPublisher({
    workspaceId: "workspace-1",
    logEpoch: "index-epoch",
    topic: sessionsIndexTopic("workspace-1"),
    subscriptionId: "index-sub",
    now: () => 80,
  });
  const events = [event(1, "turn.started", { turnId: "turn-1" })];
  publisher.publish({
    clientMode: "desktop-continuous",
    sessions: [{ spec, runtimeEpoch: epoch, events }],
  });
  const gapped = publisher.publish({
    clientMode: "desktop-continuous",
    sessions: [
      {
        spec,
        runtimeEpoch: epoch,
        events: [event(1, "turn.started", { turnId: "turn-1" }), event(3, "turn.finished", { turnId: "turn-1", outcome: "success" })],
      },
    ],
  });
  assert.equal(gapped.mode, "resync");
  assert.equal(gapped.reason, "sequence-gap");
  assert.equal(publisher.current().snapshot.sessions[0]?.sessionId, spec.hostSessionId);
});

test("advanced commands are rejected intact and supported commands keep their fields", () => {
  const envelopeBase = {
    commandId: "cmd-1",
    clientId: "client-1",
    sessionId: spec.hostSessionId,
    issuedAt: 10,
  };
  const rejected = translateV4Command({
    spec,
    runtimeEpoch: epoch,
    revision: 4,
    envelope: {
      ...envelopeBase,
      type: "sendText",
      payload: { text: "hello", attachments: [{ ref: "a", fileName: "a.png", mime: "image/png", bytes: 4 }] },
    },
  });
  assert.equal(rejected.kind, "rejected");
  if (rejected.kind !== "rejected") return;
  assert.deepEqual(commandAckSchema.parse(rejected.ack), rejected.ack);
  assert.equal(rejected.ack.status, "rejected");
  assert.equal(rejected.ack.reasonCode, "externalHarnessUnsupported");
  assert.match(rejected.ack.message ?? "", /attachments/);

  const sent = translateV4Command({
    spec,
    runtimeEpoch: epoch,
    revision: 4,
    nextTurnId: "turn-9",
    envelope: { ...envelopeBase, commandId: "cmd-send", type: "sendText", payload: { text: "hello" } },
  });
  assert.equal(sent.kind, "command");
  if (sent.kind !== "command") return;
  assert.equal(sent.command.type, "send");
  if (sent.command.type !== "send") return;
  assert.equal(sent.command.text, "hello");
  assert.equal(sent.command.turnId, "turn-9");
  assert.equal(sent.command.commandId, "cmd-send");

  const stop = translateV4Command({
    spec,
    runtimeEpoch: epoch,
    revision: 4,
    envelope: {
      ...envelopeBase,
      commandId: "cmd-stop",
      type: "stop",
      payload: { expectedForegroundExecutionId: "turn-9" },
    },
  });
  assert.equal(stop.kind, "command");
  if (stop.kind !== "command" || stop.command.type !== "cancelTurn") return;
  assert.equal(stop.command.turnId, "turn-9");
  assert.equal(stop.command.runtimeEpoch, epoch);

  const unboundStop = translateV4Command({
    spec,
    runtimeEpoch: epoch,
    revision: 4,
    envelope: { ...envelopeBase, commandId: "cmd-stop-late", type: "stop", payload: {} },
  });
  assert.equal(unboundStop.kind, "rejected");
  if (unboundStop.kind !== "rejected") return;
  assert.equal(unboundStop.ack.reasonCode, "stale-turn");

  const snapshot = projectHostConversation({
    spec,
    runtimeEpoch: epoch,
    events: [
      event(1, "turn.started", { turnId: "turn-1" }),
      event(2, "tool.started", { turnId: "turn-1", toolCallId: "tool-1", name: "write" }),
      event(3, "interaction.requested", {
        turnId: "turn-1",
        interactionId: "approval-1",
        toolCallId: "tool-1",
        summary: "Write?",
      }),
    ],
  });
  const approval = translateV4Command({
    spec,
    runtimeEpoch: epoch,
    revision: snapshot.revision,
    rows: snapshot.rows.window,
    pendingInteractions: snapshot.pendingInteractions,
    envelope: {
      ...envelopeBase,
      commandId: "cmd-approval",
      type: "resolveInteraction",
      payload: { interactionId: "approval-1", answer: { optionId: "deny", freeText: "no" } },
    },
  });
  assert.equal(approval.kind, "command");
  if (approval.kind !== "command" || approval.command.type !== "resolveInteraction") return;
  assert.equal(approval.command.decision, "deny");
  assert.equal(approval.command.turnId, "turn-1");
  assert.equal(approval.command.answer, "no");

  for (const type of ["forkAssistant", "compact", "pauseGoal", "switchModelConfig", "sendQueuedNow"] as const) {
    const payload =
      type === "forkAssistant"
        ? { target: { rowId: 1, entityId: "row-1" } }
        : type === "switchModelConfig"
          ? { provider: "p", model: "m", thought: "low" }
          : type === "sendQueuedNow"
            ? { queueItemId: "q1" }
            : {};
    const result = translateV4Command({
      spec,
      runtimeEpoch: epoch,
      revision: 1,
      envelope: {
        ...envelopeBase,
        commandId: `cmd-${type}`,
        type,
        baseRevision: 1,
        baseLogEpoch: epoch,
        payload,
      },
    });
    assert.equal(result.kind, "rejected");
    if (result.kind !== "rejected") continue;
    assert.equal(result.ack.reasonCode, "externalHarnessUnsupported");
    assert.match(result.ack.message ?? "", new RegExp(type));
  }
});
