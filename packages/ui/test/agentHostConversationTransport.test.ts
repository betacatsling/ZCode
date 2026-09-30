import assert from "node:assert/strict";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import type { IAgentHostService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  commandAckSchema,
  conversationTopic,
  conversationTopicFrameSchema,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { AgentCommand, AgentCommandReceipt, AgentEvent } from "@zcode/shared/agent-host";
import { projectHostConversation } from "../../services/src/agent-ui-projection/projector.js";
import { toProviderReconfigureFailure } from "../../services/src/agent-host/modelFailureClassification.js";
import { createAgentHostConversationTransport } from "../src/v4/agentHostConversationTransport.js";

const spec = {
  schemaVersion: 1 as const,
  hostSessionId: "external-transport",
  execution: { targetId: "local", workspaceIdentity: "workspace", worktreePath: "/worktree" },
  harness: { id: "mock", adapterVersion: "1.0.0" },
  modelBinding: {
    kind: "host-managed" as const,
    selection: { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "off" } },
  },
};

function makeClient(
  agentEvents: AgentEvent[] = [],
  receiptFor?: (command: AgentCommand) => AgentCommandReceipt,
) {
  const events = new Emitter<ConversationTopicWireCandidate>();
  const snapshot = projectHostConversation({
    spec,
    runtimeEpoch: "epoch-1",
    events: agentEvents,
  });
  const dispatched: AgentCommand[] = [];
  const requestedPolicies: string[] = [];
  let ordinal = 0;
  const emit = (deliveryKind: "initial" | "recovery") => {
    const topic = conversationTopic(spec.hostSessionId);
    const wire = {
      wireVersion: V4_WIRE_PROTOCOL_VERSION,
      kind: "complete",
      deliveryKind,
      logicalFrameId: `${deliveryKind}-${++ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic,
      subscriptionId: "sub-1",
      frame: {
        topic,
        subscriptionId: "sub-1",
        fromSeq: 0,
        toSeq: snapshot.seq,
        sentAt: Date.now(),
        payload: { kind: "snapshot", snapshot },
      },
    } satisfies ConversationTopicWireCandidate;
    const checked = conversationTopicFrameSchema.safeParse(wire.frame);
    if (!checked.success) throw new Error(JSON.stringify(checked.error.issues));
    events.fire(wire);
  };
  const client = {
    onConversationFrame: events.event,
    async createExternalSession() {
      return {
        locator: {
          targetId: "local",
          workspaceIdentity: "workspace",
          harnessId: "mock",
          hostSessionId: spec.hostSessionId,
        },
        snapshot,
      };
    },
    async subscribeConversation(request: { runtimePolicy: string }) {
      requestedPolicies.push(request.runtimePolicy);
      emit("initial");
      return { ack: { subscriptionId: "sub-1", mode: "snapshot" as const, logEpoch: "epoch-1" } };
    },
    async resyncConversation() {
      emit("recovery");
      return { ack: { subscriptionId: "sub-1", mode: "snapshot" as const, logEpoch: "epoch-1" } };
    },
    async unsubscribeConversation() {},
    async conversationRowsRange() {
      return { rows: [], atSeq: 0, atRevision: 0, atLogEpoch: "epoch-1", hasMore: false };
    },
    async dispatch(_spec: typeof spec, command: AgentCommand): Promise<AgentCommandReceipt> {
      dispatched.push(command);
      return receiptFor?.(command) ?? { commandId: command.commandId, status: "accepted" };
    },
    async snapshot() {
      return snapshot;
    },
    async queryCommand() {
      return undefined;
    },
  } as unknown as Pick<
    IAgentHostService,
    | "onConversationFrame"
    | "createExternalSession"
    | "subscribeConversation"
    | "resyncConversation"
    | "unsubscribeConversation"
    | "conversationRowsRange"
    | "dispatch"
    | "snapshot"
    | "queryCommand"
  >;
  return { client, dispatched, requestedPolicies };
}

test("external transport stages ACK-before-frame, recovers same subscription, and preserves command identity", async () => {
  const { client, dispatched, requestedPolicies } = makeClient();
  const transport = createAgentHostConversationTransport(client, {
    spec,
    clientMode: "desktop-continuous",
    runtimePolicy: "start-if-needed",
  });
  const deliveries: string[] = [];
  transport.onFrame((_frame, context) => deliveries.push(context?.deliveryKind ?? "unknown"));
  const subscribe = await transport.subscribe({ topic: conversationTopic(spec.hostSessionId) });
  assert.deepEqual(requestedPolicies, ["start-if-needed"]);
  transport.activate(subscribe.ack.subscriptionId);
  assert.deepEqual(deliveries, ["initial"]);

  await transport.resync({ subscriptionId: subscribe.ack.subscriptionId, base: null });
  assert.deepEqual(deliveries, ["initial", "recovery"]);

  const ack = await transport.sendCommand({
    commandId: "command-1",
    clientId: "client-1",
    sessionId: spec.hostSessionId,
    type: "sendText",
    payload: {
      text: "hello",
      modelSelection: spec.modelBinding.selection,
      requestedDelivery: "startNow",
    },
    issuedAt: Date.now(),
  });
  assert.equal(ack.status, "accepted");
  assert.deepEqual(dispatched[0], {
    type: "send",
    commandId: "command-1",
    hostSessionId: spec.hostSessionId,
    turnId: "command-1",
    text: "hello",
  });
  await assert.rejects(
    transport.plans({ sessionId: spec.hostSessionId }),
    /externalHarnessUnsupported/,
  );
  transport.dispose();
});

test("read-only desktop subscription stays cold until attach policy is explicit", async () => {
  const { client, requestedPolicies } = makeClient();
  const transport = createAgentHostConversationTransport(client, {
    spec,
    clientMode: "desktop-continuous",
  });
  const subscribe = await transport.subscribe({ topic: conversationTopic(spec.hostSessionId) });
  assert.deepEqual(requestedPolicies, ["existing-only"]);
  transport.activate(subscribe.ack.subscriptionId);
  transport.dispose();
});

test("external stop retains the caller's expected turn and epoch", async () => {
  const { client, dispatched, requestedPolicies } = makeClient();
  const transport = createAgentHostConversationTransport(client, {
    spec,
    clientMode: "web-remote-replayable",
  });
  const deliveries: string[] = [];
  transport.onFrame((_frame, context) => deliveries.push(context?.deliveryKind ?? "unknown"));
  const subscribe = await transport.subscribe({ topic: conversationTopic(spec.hostSessionId) });
  assert.deepEqual(requestedPolicies, ["existing-only"]);
  transport.activate(subscribe.ack.subscriptionId);
  await transport.resync({ subscriptionId: subscribe.ack.subscriptionId, base: null });
  assert.deepEqual(deliveries, ["initial", "recovery"]);
  const ack = await transport.sendCommand({
    commandId: "stop-1",
    clientId: "client-1",
    sessionId: spec.hostSessionId,
    baseLogEpoch: "epoch-requested",
    type: "stop",
    payload: { expectedForegroundExecutionId: "turn-requested" },
    issuedAt: Date.now(),
  });
  assert.equal(ack.status, "accepted");
  assert.deepEqual(dispatched[0], {
    type: "cancelTurn",
    commandId: "stop-1",
    hostSessionId: spec.hostSessionId,
    runtimeEpoch: "epoch-requested",
    turnId: "turn-requested",
  });
  transport.dispose();
});

test("conflicting approval action and declared option is rejected before dispatch", async () => {
  const approvalEvents: AgentEvent[] = [
    {
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: "epoch-1",
      sequence: 1,
      eventId: "turn-started",
      at: 1,
      kind: "turn.started",
      turnId: "turn-1",
    },
    {
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: "epoch-1",
      sequence: 2,
      eventId: "tool-started",
      at: 2,
      kind: "tool.started",
      turnId: "turn-1",
      toolCallId: "tool-1",
      name: "write",
    },
    {
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: "epoch-1",
      sequence: 3,
      eventId: "approval-requested",
      at: 3,
      kind: "interaction.requested",
      turnId: "turn-1",
      interactionId: "approval-1",
      toolCallId: "tool-1",
      summary: "Write file?",
    },
  ];
  const { client, dispatched } = makeClient(approvalEvents);
  const transport = createAgentHostConversationTransport(client, {
    spec,
    clientMode: "web-remote-replayable",
  });
  await assert.rejects(
    transport.sendCommand({
      commandId: "approval-1",
      clientId: "client-1",
      sessionId: spec.hostSessionId,
      baseLogEpoch: "epoch-1",
      type: "resolveInteraction",
      payload: {
        interactionId: "approval-1",
        answer: { action: "decline", optionId: "allow" },
      },
      issuedAt: Date.now(),
    }),
    /interaction-answer-conflict/,
  );
  assert.equal(dispatched.length, 0);
  transport.dispose();
});

const SECRET_KEY = "sk-live-never-in-ack";
const SECRET_URL = "https://gateway.internal.example/v1";

function sendText(commandId: string) {
  return {
    commandId,
    clientId: "client-1",
    sessionId: spec.hostSessionId,
    type: "sendText" as const,
    payload: {
      text: "hello",
      modelSelection: spec.modelBinding.selection,
      requestedDelivery: "startNow" as const,
    },
    issuedAt: Date.now(),
  };
}

test("provider-reconfigure-required ack keeps the host receipt's typed failure (401 and 403)", async () => {
  // Shared rule output: non-retryable auth_failed, 401 and 403 alike (no 401-only narrowing).
  const failures = [401, 403].map((statusCode) =>
    toProviderReconfigureFailure({
      reason: "auth_failed",
      providerId: "provider-rejected",
      modelId: "model-rejected",
      statusCode,
      retryable: false,
    }),
  );
  for (const failure of failures) {
    assert.ok(failure);
    const { client } = makeClient([], (command) => ({
      commandId: command.commandId,
      status: "rejected",
      reasonCode: "provider-reconfigure-required",
      message: "Provider credential was rejected; reconfigure the Provider.",
      failure,
    }));
    const transport = createAgentHostConversationTransport(client, {
      spec,
      clientMode: "desktop-continuous",
    });
    const ack = await transport.sendCommand(sendText(`send-${failure.statusCode}`));
    assert.equal(ack.status, "rejected");
    assert.equal(ack.reasonCode, "provider-reconfigure-required");
    assert.deepEqual(ack.failure, failure);
    assert.equal(ack.failure?.providerId, "provider-rejected");
    assert.equal(ack.failure?.statusCode, failure.statusCode);
    assert.deepEqual(commandAckSchema.parse(ack), ack);
    const wire = JSON.stringify(ack);
    assert.ok(!wire.includes(SECRET_KEY) && !wire.includes(SECRET_URL));
    assert.doesNotMatch(wire, /sk-|https?:\/\//);
    transport.dispose();
  }
});

test("an untyped rejection (old host or non-credential failure) yields an ack without a failure key", async () => {
  const receipts: AgentCommandReceipt[] = [
    { commandId: "send-old", status: "rejected", reasonCode: "provider-reconfigure-required" },
    { commandId: "send-backend", status: "rejected", reasonCode: "backend-failure" },
    { commandId: "send-ok", status: "accepted" },
  ];
  for (const receipt of receipts) {
    const { client } = makeClient([], () => receipt);
    const transport = createAgentHostConversationTransport(client, {
      spec,
      clientMode: "desktop-continuous",
    });
    const ack = await transport.sendCommand(sendText(receipt.commandId));
    assert.equal(Object.hasOwn(ack, "failure"), false);
    assert.equal(ack.reasonCode, receipt.reasonCode);
    transport.dispose();
  }
});
