import { createServer } from "node:http";
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

const http = createServer();
const wss = new WebSocketServer({ noServer: true });
const tickets = new Set(["child-1", "child-2"]);
http.on("upgrade", (request, socket, head) => {
  const ticket = request.headers["x-zcode-rpc-host-capability"];
  if (typeof ticket !== "string" || !tickets.delete(ticket)) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
    const data = new Emitter<VSBuffer>();
    const close = new Emitter<void>();
    ws.on("message", (raw) => data.fire(VSBuffer.wrap(Buffer.from(raw as Buffer))));
    ws.on("close", () => close.fire());
    const socket: ISocket = {
      onData: data.event,
      onClose: close.event,
      onEnd: close.event,
      write(buffer) {
        ws.send(buffer.buffer);
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
          target: { id: "child-target", kind: "local", platform: "darwin", available: true },
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
  });
});
http.listen(0, "127.0.0.1", () => {
  const address = http.address();
  if (address && typeof address !== "string") process.send?.({ port: address.port });
});
process.on("message", () => {
  for (const ws of wss.clients) ws.terminate();
  wss.close(() => http.close(() => process.exit(0)));
});
