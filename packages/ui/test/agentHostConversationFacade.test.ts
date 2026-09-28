import assert from "node:assert/strict";
import test from "node:test";
import { createAgentHostConversationFacade } from "../src/v4/agentHostConversationFacade.js";
import type { ConversationTransport } from "../src/v4/transport.js";

function fake(label: string, received: string[]): ConversationTransport {
  return new Proxy({} as ConversationTransport, {
    get(_target, property) {
      return async (params: { sessionId?: string; topic?: string }) => {
        received.push(`${label}.${String(property)}.${params?.sessionId ?? params?.topic ?? ""}`);
        if (property === "subscribe")
          return { ack: { subscriptionId: `${label}-sub`, mode: "snapshot", logEpoch: "epoch" } };
      };
    },
  });
}

test("facade off is the native object; on never sends unknown/external commands to native", async () => {
  const received: string[] = [];
  const native = fake("native", received);
  const external = fake("external", received);
  const options = {
    native,
    external,
    enabled: false,
    locateSession: (id: string) =>
      id === "legacy" ? ("native" as const) : id === "pi-1" ? ("external" as const) : undefined,
  };
  assert.equal(createAgentHostConversationFacade(options), native);
  const facade = createAgentHostConversationFacade({ ...options, enabled: true });
  await facade.rowsRange({ sessionId: "legacy", limit: 20 });
  await facade.rowsRange({ sessionId: "pi-1", limit: 20 });
  assert.throws(
    () => facade.rowsRange({ sessionId: "unknown", limit: 20 }),
    /unknown session owner/,
  );
  assert.deepEqual(received, ["native.rowsRange.legacy", "external.rowsRange.pi-1"]);
});
