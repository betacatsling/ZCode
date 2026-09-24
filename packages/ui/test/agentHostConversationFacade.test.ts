import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentHostConversationFacade,
  createScopedAgentHostConversationFacade,
} from "../src/v4/agentHostConversationFacade.js";
import type {
  AgentHostConversationPort,
  AgentHostConversationTransport,
} from "../src/v4/agentHostConversationTransport.js";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import type { ConversationTransport } from "../src/v4/transport.js";

function fake(label: string, received: string[]): ConversationTransport {
  return new Proxy({} as ConversationTransport, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === "activate")
        return (id: string) => {
          received.push(`${label}.activate.${id}`);
        };
      if (
        property === "onFrame" ||
        property === "onAssemblyFault" ||
        property === "onRuntimeRestart"
      )
        return () => () => {};
      return async (params: { sessionId?: string; topic?: string; subscriptionId?: string }) => {
        received.push(
          `${label}.${String(property)}.${params?.sessionId ?? params?.topic ?? params?.subscriptionId ?? ""}`,
        );
        if (property === "subscribe")
          return { ack: { subscriptionId: `${label}-sub`, mode: "snapshot", logEpoch: "epoch" } };
      };
    },
  });
}
const owners = {
  locateSession: async (id: string) =>
    id === "native" ? ("native" as const) : id === "host" ? ("external" as const) : undefined,
};

test("feature-off keeps original native object; unknown cannot route native; admission flag does not hide history", async () => {
  const received: string[] = [];
  const native = fake("native", received);
  const external = fake("external", received) as AgentHostConversationTransport;
  const options = { native, external, enabled: false, owners, externalAdmissionEnabled: false };
  assert.equal(createAgentHostConversationFacade(options), native);
  const facade = createAgentHostConversationFacade({ ...options, enabled: true });
  await facade.rowsRange({ sessionId: "native", limit: 20 });
  await facade.rowsRange({ sessionId: "host", limit: 20 });
  await assert.rejects(
    facade.rowsRange({ sessionId: "unknown", limit: 20 }),
    /unknown session owner/,
  );
  assert.deepEqual(received, ["native.rowsRange.native", "external.rowsRange.host"]);
});

test("create-query checks both durable owners, preserves native clock, and rejects colliding claims", async () => {
  const seen: string[] = [];
  const makeQuery = (label: string, claimed: string[]) => ({
    ...fake(label, seen),
    async queryCommands(params: {
      commands: Array<{ sessionId: string | null; commandId: string }>;
      clock?: true;
    }) {
      seen.push(
        `${label}:${params.commands.map((key) => key.commandId).join(",")}:${params.clock ? "clock" : "no-clock"}`,
      );
      return {
        results: params.commands.map((key) => ({
          key,
          result: claimed.includes(key.commandId)
            ? { commandId: key.commandId, status: "accepted" as const, revisionAtDecision: 0 }
            : ("unknown" as const),
        })),
        ...(params.clock ? { clock: { hostReceivedAt: 1, hostSentAt: 2 } } : {}),
      };
    },
  });
  const native = makeQuery("native", ["n", "collision"]);
  const external = makeQuery("external", ["e", "collision"]) as AgentHostConversationTransport;
  const facade = createAgentHostConversationFacade({ native, external, enabled: true, owners });
  const keys = ["n", "e"].map((commandId) => ({ sessionId: null, commandId }));
  const result = await facade.queryCommands({ commands: keys, clock: true });
  assert.deepEqual(
    result.results.map((item) => (item.result === "unknown" ? "unknown" : item.result.commandId)),
    ["n", "e"],
  );
  assert.ok(result.clock);
  assert.deepEqual(seen, ["native:n,e:clock", "external:n,e:no-clock"]);
  await assert.rejects(
    facade.queryCommands({ commands: [{ sessionId: null, commandId: "collision" }] }),
    /ambiguous create command owner/,
  );
  const unknown = await facade.queryCommands({
    commands: [{ sessionId: null, commandId: "never-created" }],
  });
  assert.equal(unknown.results[0]?.result, "unknown");
  await assert.rejects(
    facade.queryCommands({ commands: [{ sessionId: "unknown", commandId: "n" }] }),
    /unknown session owner/,
  );
});

test("scoped composition accepts async owner resolver without native fallback", async () => {
  const received: string[] = [];
  const native = fake("native", received);
  const spec: SessionSpecV2 = {
    schemaVersion: 2,
    hostSessionId: "host",
    projectId: "project",
    workspaceId: "tree",
    execution: {
      targetId: "target",
      workspaceIdentity: "identity",
      worktreePath: "/tree",
      worktreeGeneration: "gen",
      cwdRelativeToWorktree: ".",
    },
    harness: { id: "pi", adapterVersion: "0.1" },
    modelBinding: { kind: "harness-managed" },
  };
  const host: AgentHostConversationPort = {
    onEvent: () => ({ dispose() {} }),
    async create() {
      throw new Error("unexpected create");
    },
    async dispatch() {
      throw new Error("unexpected dispatch");
    },
    async snapshot() {
      throw new Error("unexpected snapshot");
    },
    async eventsSince() {
      throw new Error("unexpected eventsSince");
    },
    async queryCommand() {
      throw new Error("unexpected queryCommand");
    },
    async queryCreationCommand() {
      throw new Error("unexpected queryCreationCommand");
    },
    async getSessionSpec() {
      return spec;
    },
    async rowsRange(owner) {
      received.push(`host.rows:${owner.hostSessionId}`);
      return { rows: [], atSeq: 0, atRevision: 0, atLogEpoch: "epoch", hasMore: false };
    },
  };
  const factory = createScopedAgentHostConversationFacade({
    native,
    host,
    scope: {
      targetId: "target",
      workspaceId: "tree",
      workspaceIdentity: "identity",
      worktreePath: "/tree",
    },
    locateOwner: async (id) =>
      id === "native" ? { kind: "native" } : id === "host" ? { kind: "external", spec } : undefined,
    enabled: false,
    externalAdmissionEnabled: false,
  });
  assert.equal(factory.transport, native);
  const enabled = createScopedAgentHostConversationFacade({
    native,
    host,
    scope: {
      targetId: "target",
      workspaceId: "tree",
      workspaceIdentity: "identity",
      worktreePath: "/tree",
    },
    locateOwner: async (id) =>
      id === "native" ? { kind: "native" } : id === "host" ? { kind: "external", spec } : undefined,
    enabled: true,
    externalAdmissionEnabled: false,
  });
  await enabled.transport.rowsRange({ sessionId: "host", limit: 10 });
  await assert.rejects(
    enabled.transport.rowsRange({ sessionId: "missing", limit: 10 }),
    /unknown session owner/,
  );
  assert.deepEqual(received, ["host.rows:host"]);
  enabled.dispose();
});

test("facade owns activation IDs independently even if both transports reuse topic names", async () => {
  const received: string[] = [];
  const native = fake("native", received);
  const external = fake("external", received) as AgentHostConversationTransport;
  const facade = createAgentHostConversationFacade({ native, external, enabled: true, owners });
  const a = await facade.subscribe({ topic: "conversation/native" });
  const b = await facade.subscribe({ topic: "conversation/host" });
  facade.activate(a.ack.subscriptionId);
  facade.activate(b.ack.subscriptionId);
  await facade.unsubscribe(b.ack.subscriptionId);
  assert.deepEqual(received, [
    "native.subscribe.conversation/native",
    "external.subscribe.conversation/host",
    "native.activate.native-sub",
    "external.activate.external-sub",
    "external.unsubscribe.",
  ]);
  await assert.rejects(facade.unsubscribe(b.ack.subscriptionId), /unknown subscription/);
});
