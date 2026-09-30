import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { ChannelServer, Emitter, Event, SocketProtocol, VSBuffer } from "@zcode/rpc";
import { WebSocketServer } from "ws";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import { createHostCapabilityStore } from "../hostCapability.js";
import { connectToPersistentTarget } from "./persistentTargetClient.js";

test("persistent target uses a one-time host capability and closes only the attachment", async () => {
  const capabilityStore = createHostCapabilityStore({ createCapability: () => "isolated-ticket" });
  const webSocketServer = new WebSocketServer({ noServer: true });
  const hostBootstrapToken = "A".repeat(43);
  const seenAuthorization: Record<string, string | undefined> = {};
  const server = createServer((request, response) => {
    if (request.url) seenAuthorization[request.url] = request.headers.authorization;
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
    if (request.headers.authorization !== `Bearer ${hostBootstrapToken}`) {
      response.writeHead(401).end();
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
    const valid =
      request.url === "/ws/host" &&
      request.headers.authorization === undefined &&
      capabilityStore.consume(capability);
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
      hostBootstrapToken,
    });
    assert.ok(connection.services);
    // bootstrap secret 只发给签发端点，不随 server-info 或 /ws/host 升级外泄。
    assert.equal(seenAuthorization["/api/rpc-host-capability"], `Bearer ${hostBootstrapToken}`);
    assert.equal(seenAuthorization["/api/server-info"], undefined);
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

test("persistent target surfaces a 401 when the bootstrap secret is missing", async () => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/server-info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ serverId: "local:test", capabilities: { agentHost: true } }));
      return;
    }
    response.writeHead(request.headers.authorization ? 200 : 401).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      connectToPersistentTarget({ host: "127.0.0.1", port: address.port }),
      /capability request failed \(401\)/u,
    );
  } finally {
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

test("persistent target receives the RPC Initialize a Core sends in the same tick as the upgrade", async () => {
  // The server-cli Core constructs its ChannelServer in the WebSocket open handler, so the
  // Initialize frame usually shares the TCP read with the 101 response. The client must already be
  // listening when `open` fires, or the ChannelClient never initializes and every call hangs.
  const hostBootstrapToken = "B".repeat(43);
  const capabilityStore = createHostCapabilityStore({ createCapability: () => "same-tick-ticket" });
  const webSocketServer = new WebSocketServer({ noServer: true });
  const servers: ChannelServer[] = [];
  webSocketServer.on("connection", (socket) => {
    const data = new Emitter<VSBuffer>();
    const closed = new Emitter<void>();
    socket.on("message", (raw) => data.fire(VSBuffer.wrap(raw as Buffer)));
    socket.on("close", () => closed.fire());
    const channelServer = new ChannelServer(
      new SocketProtocol({
        onData: data.event,
        onClose: closed.event,
        onEnd: closed.event,
        write: (buffer: VSBuffer) => socket.send(buffer.buffer),
        end: () => socket.close(),
        drain: () => Promise.resolve(),
        dispose: () => socket.close(),
      }),
      "core",
    );
    channelServer.registerChannel("probe", {
      call: async () => "pong" as never,
      listen: () => Event.None as never,
    });
    servers.push(channelServer);
  });
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/server-info") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ serverId: "local:tick", capabilities: { agentHost: true } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${hostBootstrapToken}`) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(capabilityStore.issue()));
  });
  server.on("upgrade", (request, socket, head) => {
    const header = request.headers[ZCODE_RPC_HOST_CAPABILITY_HEADER];
    if (!capabilityStore.consume(Array.isArray(header) ? header[0] : header)) {
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
      expectedTargetId: "local:tick",
      hostBootstrapToken,
    });
    try {
      const reply = await Promise.race([
        connection.client.getChannel("probe").call<string>("ping"),
        new Promise<string>((resolve) => setTimeout(() => resolve("no Initialize"), 2_000)),
      ]);
      assert.equal(reply, "pong");
    } finally {
      await connection.disposeAndWait();
    }
  } finally {
    for (const channelServer of servers) channelServer.dispose();
    await new Promise<void>((resolve, reject) =>
      webSocketServer.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
