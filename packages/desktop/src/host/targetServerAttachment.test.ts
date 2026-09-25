import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { openTargetHostSocket } from "./targetServerAttachment.js";

test("trusted attachment consumes a ticket once; disconnect does not stop target", async () => {
  const ticket = "one-use-ticket";
  let used = false;
  let accepted = 0;
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers["x-zcode-rpc-host-capability"] !== ticket || used) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    used = true;
    wss.handleUpgrade(request, socket, head, (ws) => {
      accepted++;
      wss.emit("connection", ws, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const target = {
      websocketUrl: `ws://127.0.0.1:${address.port}/ws/host`,
      ticket,
      expiresAt: Date.now() + 10_000,
    };
    const ws = await openTargetHostSocket(target);
    ws.close();
    await assert.rejects(openTargetHostSocket(target));
    assert.equal(accepted, 1);
    assert.equal(server.listening, true);
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
