import assert from "node:assert/strict";
import test from "node:test";
import type { IChannelServer } from "@zcode/rpc";
import { ServiceCollection } from "../src/collection.js";
import { IAgentHostService } from "../src/agent-host/serviceContract.js";

const dummy = { create: async () => undefined } as unknown as IAgentHostService;

test("untrusted generic RPC scope does not register the agent host channel", () => {
  const collection = new ServiceCollection().register(IAgentHostService, dummy);
  const registered: string[] = [];
  const server: IChannelServer = {
    registerChannel(name) {
      registered.push(name);
    },
  };
  collection.exposeOnChannelServer(server, new Map(), new Set([IAgentHostService.channelName]));
  assert.deepEqual(registered, []);
  collection.exposeOnChannelServer(server);
  assert.deepEqual(registered, [IAgentHostService.channelName]);
});
