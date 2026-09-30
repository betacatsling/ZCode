import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCommandSchema,
  agentEventSchema,
  backendBindingSchema,
  capabilityReportSchema,
  sessionSpecSchema,
} from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { planModelBinding } from "../src/agent-host/modelBindingPlanner.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";

const spec = {
  schemaVersion: 1,
  hostSessionId: "host-1",
  execution: { targetId: "local-1", workspaceIdentity: "workspace-1", worktreePath: "/tmp/demo" },
  harness: { id: "mock", adapterVersion: "1.0.0" },
  modelBinding: {
    kind: "host-managed",
    selection: { providerId: "provider-a", modelId: "model-a" },
  },
} as const;

test("wire schemas reject malformed identities, secrets and ambiguous commands", () => {
  assert.equal(sessionSpecSchema.safeParse(spec).success, true);
  assert.equal(sessionSpecSchema.safeParse({ ...spec, secret: "never" }).success, false);
  assert.equal(sessionSpecSchema.safeParse({ ...spec, hostSessionId: "" }).success, false);
  assert.equal(
    backendBindingSchema.safeParse({
      hostSessionId: "host-1",
      backendSessionId: "pi-1",
      backendVersion: "1",
      runtimeEpoch: "e",
    }).success,
    true,
  );
  assert.equal(capabilityReportSchema.safeParse({ support: "unsupported" }).success, false);
  assert.equal(
    capabilityReportSchema.safeParse({ support: "unknown", reason: "not probed" }).success,
    true,
  );
  assert.equal(
    agentCommandSchema.safeParse({ type: "cancelTurn", commandId: "stop", hostSessionId: "host-1" })
      .success,
    false,
  );
  assert.equal(
    agentCommandSchema.safeParse({
      type: "resolveInteraction",
      commandId: "answer",
      hostSessionId: "host-1",
      runtimeEpoch: "e",
      interactionId: "i",
      decision: "allow",
    }).success,
    false,
  );
  assert.equal(
    agentEventSchema.safeParse({
      kind: "text.delta",
      hostSessionId: "host-1",
      runtimeEpoch: "e",
      sequence: 1,
      eventId: "ev",
      at: 123,
      messageId: "m",
      turnId: "t",
      text: "ok",
    }).success,
    true,
  );
});

test("registry refuses unknown harness, duplicate IDs and unverified model routes", async () => {
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.register(mock);
  assert.throws(() => registry.register(mock), /duplicate/i);
  assert.throws(() => registry.require("not-installed"), /unknown/i);
  const bad = await planModelBinding({
    spec,
    target: { id: "local-1", kind: "local", platform: "darwin", available: true },
    harness: mock,
    catalog: {
      fingerprint: "revision-1",
      validateSelection: () => ({ ok: false as const, reason: "model-not-found" }),
    },
  });
  assert.equal(bad.support.support, "unsupported");
  assert.match(bad.support.reason ?? "", /model-not-found/);
  const wrongTarget = await planModelBinding({
    spec,
    target: { id: "different", kind: "local", platform: "darwin", available: true },
    harness: mock,
    catalog: { fingerprint: "revision-1", validateSelection: () => ({ ok: true as const }) },
  });
  assert.equal(wrongTarget.support.support, "unsupported");
});

test("mock emits text/tool/approval and faults without pretending a denied tool ran", async () => {
  const mock = new MockHarness();
  const events: unknown[] = [];
  const unsubscribe = mock.subscribe("host-1", (event) => events.push(event));
  await mock.create(spec);
  const execution = mock.send({
    type: "send",
    commandId: "send-1",
    hostSessionId: "host-1",
    turnId: "turn-1",
    text: "edit file",
  });
  await mock.waitForInteraction("host-1");
  assert.equal(
    events.some((event) => (event as { kind: string }).kind === "interaction.requested"),
    true,
  );
  await mock.resolveInteraction({
    type: "resolveInteraction",
    commandId: "deny-1",
    hostSessionId: "host-1",
    runtimeEpoch: mock.epoch("host-1"),
    turnId: "turn-1",
    interactionId: "approval-1",
    decision: "deny",
  });
  await execution;
  assert.equal(
    events.some((event) => (event as { kind: string }).kind === "tool.finished"),
    false,
  );
  assert.equal(
    events.some((event) => (event as { kind: string }).kind === "turn.finished"),
    true,
  );
  const count = events.length;
  mock.emitDuplicate("host-1");
  assert.equal(events.length, count + 1);
  unsubscribe();
});
