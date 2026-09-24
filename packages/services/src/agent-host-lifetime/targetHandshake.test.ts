import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { prepareTargetAttachment } from "./targetHandshake.js";

const info = {
  serverId: "installed-target",
  version: "3.14.3",
  protocolVersion: 1,
  authRequired: false,
  workspaces: [],
  capabilities: { desktopContinuous: true, websocketRpc: true, agentHost: true },
};

test("attachment handshake rejects mismatched identity/version before requesting ticket", async () => {
  let tickets = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/server-info") response.end(JSON.stringify(info));
    else {
      tickets++;
      response.end(JSON.stringify({ capability: "secret", expiresAt: Date.now() + 10_000 }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    await assert.rejects(prepareTargetAttachment(endpoint, "other-target"), /identity/);
    await assert.rejects(
      prepareTargetAttachment(endpoint, "installed-target", async () => ({
        ...info,
        protocolVersion: 2,
      })),
      /protocol/,
    );
    await assert.rejects(
      prepareTargetAttachment(endpoint, "installed-target", undefined, "4.0.0"),
      /version/,
    );
    assert.equal(tickets, 0);
    const attached = await prepareTargetAttachment(endpoint, "installed-target");
    assert.equal(attached.serverId, info.serverId);
    assert.equal(attached.ticket, "secret");
    assert.equal(tickets, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
