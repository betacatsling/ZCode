import { RemoteServiceAccess } from "@zcode/client";
import { ChannelClient, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import WebSocket from "ws";
import {
  openTargetHostSocket,
  type HostAttachmentTicket,
} from "../main/targetServerAttachment.js";

/** A window-scoped attachment; the Core/Supervisor are independent owners. */
export interface TargetHostRpcAttachment {
  readonly services: IServiceAccessor;
  dispose(): void;
}

/** Ticket comes from an authenticated, identity-validated target handshake. Never reconnect with it. */
export async function connectTargetHostRpc(
  ticket: HostAttachmentTicket,
): Promise<TargetHostRpcAttachment> {
  const ws = await openTargetHostSocket(ticket);
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  const socket: ISocket = {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer.buffer);
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
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  let disposed = false;
  return {
    services: new RemoteServiceAccess(client),
    dispose() {
      if (disposed) return;
      disposed = true;
      client.dispose();
      protocol.dispose();
      ws.close();
      data.dispose();
      close.dispose();
    },
  };
}
