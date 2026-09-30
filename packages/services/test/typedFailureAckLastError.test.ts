import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  agentCommandReceiptSchema,
  agentModelFailureSchema,
  externalSessionCreateResultSchema,
  type AgentEvent,
} from "@zcode/shared/agent-host";
import {
  commandAckSchema,
  conversationSnapshotSchema,
  sessionErrorInfoSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { toProviderReconfigureFailure } from "../src/agent-host/modelFailureClassification.js";
import { projectHostConversation } from "../src/agent-ui-projection/projector.js";

// Typed provider failure must reach the V4 ack and snapshot lastError as an OPTIONAL field:
// new clients read it, old payloads without it still parse, old schemas drop it harmlessly.

const failure = {
  reason: "auth_failed",
  action: "reconfigure-provider",
  providerId: "provider-a",
  modelId: "model-a",
  statusCode: 401,
  retryable: false,
} as const;

const spec = {
  schemaVersion: 1 as const,
  hostSessionId: "host-typed-failure",
  execution: { targetId: "local-1", workspaceIdentity: "workspace-1", worktreePath: "/tmp/test" },
  harness: { id: "pi", adapterVersion: "0.87.1" },
  modelBinding: {
    kind: "host-managed" as const,
    selection: { providerId: "provider-a", modelId: "model-a" },
  },
};
const epoch = randomUUID();

function event(sequence: number, kind: AgentEvent["kind"], rest: Record<string, unknown>) {
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

function failedTurn(errorRest: Record<string, unknown>): AgentEvent[] {
  return [
    event(1, "turn.started", { turnId: "turn-1" }),
    event(2, "session.error", { turnId: "turn-1", ...errorRest }),
    event(3, "turn.finished", { turnId: "turn-1", outcome: "failed" }),
  ];
}

const typedErrorEvents = failedTurn({
  code: "provider-reconfigure-required",
  message: "Provider provider-a rejected the key (401)",
  failure,
});

const ack = {
  commandId: "cmd-1",
  status: "rejected",
  reasonCode: "provider-reconfigure-required",
  message: "Provider provider-a needs reconfiguration",
  revisionAtDecision: 3,
} as const;

const lastError = {
  code: "provider-reconfigure-required",
  message: "Provider provider-a rejected the key (401)",
  recoverable: false,
  at: 2000,
  source: "runtime",
} as const;

test("V4 commandAck carries the host receipt's typed failure unchanged", () => {
  const receipt = agentCommandReceiptSchema.parse({
    commandId: "cmd-1",
    status: "rejected",
    reasonCode: "provider-reconfigure-required",
    message: ack.message,
    failure,
  });
  const parsed = commandAckSchema.parse({ ...ack, failure: receipt.failure });
  assert.deepEqual(parsed.failure, failure);
  assert.deepEqual(commandAckSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
});

test("V4 commandAck without failure (old server) still parses with no failure key", () => {
  const parsed = commandAckSchema.parse(ack);
  assert.deepEqual(parsed, ack);
  assert.equal("failure" in parsed, false);
});

test("V4 commandAck and lastError reuse the strict shared failure shape", () => {
  const leaky = { ...failure, apiKey: "sk-secret" };
  assert.equal(agentModelFailureSchema.safeParse(leaky).success, false);
  assert.equal(commandAckSchema.safeParse({ ...ack, failure: leaky }).success, false);
  assert.equal(sessionErrorInfoSchema.safeParse({ ...lastError, failure: leaky }).success, false);
  assert.equal(
    commandAckSchema.safeParse({ ...ack, failure: { ...failure, action: "retry" } }).success,
    false,
  );
});

test("an older client schema without failure ignores the new field on ack and lastError", () => {
  const oldAckSchema = commandAckSchema.omit({ failure: true });
  const oldErrorSchema = sessionErrorInfoSchema.omit({ failure: true });
  assert.deepEqual(oldAckSchema.parse({ ...ack, failure }), ack);
  assert.deepEqual(oldErrorSchema.parse({ ...lastError, failure }), lastError);
});

test("sessionErrorInfo without failure (old server) still parses with no failure key", () => {
  const parsed = sessionErrorInfoSchema.parse(lastError);
  assert.deepEqual(parsed, lastError);
  assert.equal("failure" in parsed, false);
  assert.deepEqual(sessionErrorInfoSchema.parse({ ...lastError, failure }).failure, failure);
});

test("projector copies session.error failure into control.lastError", () => {
  const snapshot = projectHostConversation({
    spec,
    runtimeEpoch: epoch,
    events: typedErrorEvents,
  });
  assert.equal(snapshot.control.lastError?.code, "provider-reconfigure-required");
  assert.equal(snapshot.control.lastError?.message, "Provider provider-a rejected the key (401)");
  assert.deepEqual(snapshot.control.lastError?.failure, failure);
  assert.equal(JSON.stringify(snapshot).includes("sk-"), false);
});

test("non-retryable auth_failed 403 failure passes through ack and lastError unchanged", () => {
  // Same shape the shared classifier produces for the turn-level session.error.
  const forbidden = toProviderReconfigureFailure({
    reason: "auth_failed",
    providerId: "provider-a",
    modelId: "model-a",
    statusCode: 403,
    retryable: false,
  });
  assert.deepEqual(forbidden, { ...failure, statusCode: 403 });
  const snapshot = projectHostConversation({
    spec,
    runtimeEpoch: epoch,
    events: failedTurn({
      code: "provider-reconfigure-required",
      message: "Provider provider-a refused the request (403)",
      failure: forbidden,
    }),
  });
  assert.deepEqual(snapshot.control.lastError?.failure, forbidden);
  assert.deepEqual(commandAckSchema.parse({ ...ack, failure: forbidden }).failure, forbidden);
});

test("untyped session.error keeps lastError unchanged, with no failure key", () => {
  const snapshot = projectHostConversation({
    spec,
    runtimeEpoch: epoch,
    events: failedTurn({ code: "unsupported", message: "tool outside the certified set" }),
  });
  assert.deepEqual(snapshot.control.lastError, {
    code: "unsupported",
    message: "tool outside the certified set",
    recoverable: false,
    at: 2000,
    source: "runtime",
  });
  assert.equal("failure" in (snapshot.control.lastError ?? {}), false);
});

test("a later untyped session.error replaces an earlier typed failure", () => {
  const snapshot = projectHostConversation({
    spec,
    runtimeEpoch: epoch,
    events: [
      ...typedErrorEvents,
      event(4, "turn.started", { turnId: "turn-2" }),
      event(5, "session.error", { turnId: "turn-2", code: "unsupported", message: "later" }),
      event(6, "turn.finished", { turnId: "turn-2", outcome: "failed" }),
    ],
  });
  assert.equal(snapshot.control.lastError?.code, "unsupported");
  assert.equal("failure" in (snapshot.control.lastError ?? {}), false);
});

test("lastError.failure survives cold re-projection and the serialized snapshot boundary", () => {
  const live = projectHostConversation({ spec, runtimeEpoch: epoch, events: typedErrorEvents });
  // Cold read: a reopened host rebuilds from the journaled events (JSON on disk).
  const journal = JSON.parse(JSON.stringify(typedErrorEvents)) as AgentEvent[];
  const cold = projectHostConversation({ spec, runtimeEpoch: epoch, events: journal });
  assert.deepEqual(cold.control.lastError, live.control.lastError);
  assert.deepEqual(cold.control.lastError?.failure, failure);
  // Wire: snapshot JSON re-parsed by a client, including the create-session envelope.
  const wire = conversationSnapshotSchema.parse(JSON.parse(JSON.stringify(cold)));
  assert.deepEqual(wire.control.lastError?.failure, failure);
  const created = externalSessionCreateResultSchema.parse(
    JSON.parse(
      JSON.stringify({
        locator: {
          targetId: "local-1",
          workspaceIdentity: "workspace-1",
          harnessId: "pi",
          hostSessionId: spec.hostSessionId,
        },
        snapshot: cold,
      }),
    ),
  );
  assert.deepEqual(created.snapshot.control.lastError?.failure, failure);
});
