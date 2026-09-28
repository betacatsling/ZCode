import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import { createHostCapabilityStore } from "../hostCapability.js";
import { connectToPersistentTarget } from "./persistentTargetClient.js";

test("persistent target uses a one-time host capability and closes only the attachment", async () => {
  const capabilityStore = createHostCapabilityStore({ createCapability: () => "isolated-ticket" });
  const webSocketServer = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200).end("ready");
      return;
    }
    if (request.method === "GET" && request.url === "/api/server-info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ serverId: "local:test", capabilities: { agentHost: true } }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/rpc-host-capability") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(capabilityStore.issue()));
  });
  let attachmentClosed = false;
  let resolveAttachmentClosed = (): void => undefined;
  const attachmentClosedPromise = new Promise<void>((resolve) => {
    resolveAttachmentClosed = resolve;
  });
  webSocketServer.on("connection", (socket) => {
    socket.once("close", () => {
      attachmentClosed = true;
      resolveAttachmentClosed();
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const header = request.headers[ZCODE_RPC_HOST_CAPABILITY_HEADER];
    const capability = Array.isArray(header) ? header[0] : header;
    const valid = request.url === "/ws/host" && capabilityStore.consume(capability);
    if (!valid) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const connection = await connectToPersistentTarget({
      host: "127.0.0.1",
      port: address.port,
      expectedTargetId: "local:test",
    });
    assert.ok(connection.services);
    await connection.disposeAndWait();
    await attachmentClosedPromise;
    assert.equal(attachmentClosed, true);
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(await health.text(), "ready");
  } finally {
    await new Promise<void>((resolve, reject) =>
      webSocketServer.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("persistent target refuses non-loopback endpoints", async () => {
  await assert.rejects(
    connectToPersistentTarget({ host: "192.0.2.1", port: 43123 }),
    /must use a loopback endpoint/u,
  );
});
