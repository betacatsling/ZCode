import assert from "node:assert/strict";
import test from "node:test";
import { serverRemoteInfoSchema } from "@zcode/shared";

const base = {
  serverId: "old-host",
  version: "3.14.0",
  protocolVersion: 1 as const,
  authRequired: false,
  workspaces: [],
  capabilities: { desktopContinuous: true as const, websocketRpc: true as const },
};

test("older hosts omit external-agent capability; new target advertises it without a protocol bump", () => {
  assert.equal(serverRemoteInfoSchema.parse(base).capabilities.agentHost, undefined);
  assert.equal(
    serverRemoteInfoSchema.parse({
      ...base,
      capabilities: { ...base.capabilities, agentHost: true },
    }).capabilities.agentHost,
    true,
  );
});
