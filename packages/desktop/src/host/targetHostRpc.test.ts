import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  ChannelServer,
  Emitter,
  ProxyChannel,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import { IAgentHostService } from "@zcode/services";
import { WebSocketServer, type WebSocket } from "ws";
import { connectTargetHostRpc } from "./targetHostRpc.js";

function serveRpc(ws: WebSocket): void {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) => data.fire(VSBuffer.wrap(Buffer.from(raw as Buffer))));
  ws.on("close", () => close.fire());
  const socket: ISocket = {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(value) {
      ws.send(value.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
  const channel = new ChannelServer(new SocketProtocol(socket), "server");
  channel.registerChannel(
    IAgentHostService.channelName,
    ProxyChannel.fromService({
      getAvailability: async () => ({
        target: { id: "installed-target", kind: "local", platform: "darwin", available: true },
        harnesses: ["pi"],
        admissionEnabled: true,
      }),
    }),
  );
  ws.once("close", () => {
    channel.dispose();
    data.dispose();
    close.dispose();
  });
}

test("target window attachment speaks real Host RPC and detaches without stopping server", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const tickets = new Set(["ticket-1", "ticket-2"]);
  http.on("upgrade", (request, socket, head) => {
    const ticket = request.headers["x-zcode-rpc-host-capability"];
    if (typeof ticket !== "string" || !tickets.delete(ticket)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => serveRpc(ws));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const address = http.address();
    assert(address && typeof address !== "string");
    const ticket = (token: string) => ({
      websocketUrl: `ws://127.0.0.1:${address.port}/ws/host`,
      ticket: token,
      expiresAt: Date.now() + 10_000,
    });
    const first = await connectTargetHostRpc(ticket("ticket-1"));
    assert(first.services.agentHostService);
    assert.deepEqual(await first.services.agentHostService.getAvailability(), {
      target: { id: "installed-target", kind: "local", platform: "darwin", available: true },
      harnesses: ["pi"],
      admissionEnabled: true,
    });
    first.dispose();
    assert.equal(http.listening, true);
    await assert.rejects(connectTargetHostRpc(ticket("ticket-1")));
    const second = await connectTargetHostRpc(ticket("ticket-2"));
    assert(second.services.agentHostService);
    assert.deepEqual((await second.services.agentHostService.getAvailability()).harnesses, ["pi"]);
    second.dispose();
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
