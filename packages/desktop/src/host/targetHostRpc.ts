import { RemoteServiceAccess } from "@zcode/client";
import { ChannelClient, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import WebSocket from "ws";
import { openTargetHostSocket, type HostAttachmentTicket } from "./targetServerAttachment.js";

/** A window-scoped attachment; the Core/Supervisor are independent owners. */
export interface TargetHostRpcAttachment {
  readonly services: IServiceAccessor;
  dispose(): void;
}

/** Ticket comes from an authenticated, identity-validated target handshake. Never reconnect with it. */
export async function connectTargetHostRpc(
  ticket: HostAttachmentTicket,
): Promise<TargetHostRpcAttachment> {
  let client: ChannelClient | undefined;
  let protocol: SocketProtocol | undefined;
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  let ws: WebSocket;
  try {
    ws = await openTargetHostSocket(ticket, (created) => {
      created.on("message", (raw) =>
        data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
      );
      created.on("close", () => close.fire());
      created.on("error", () => close.fire());
      const socket: ISocket = {
        onData: data.event,
        onClose: close.event,
        onEnd: close.event,
        write(buffer) {
          if (created.readyState === WebSocket.OPEN) created.send(buffer.buffer);
        },
        end() {
          created.close();
        },
        drain() {
          return Promise.resolve();
        },
        dispose() {
          created.close();
        },
      };
      protocol = new SocketProtocol(socket);
      client = new ChannelClient(protocol);
    });
  } catch (error) {
    client?.dispose();
    protocol?.dispose();
    data.dispose();
    close.dispose();
    throw error;
  }
  if (!client || !protocol) throw new Error("Target RPC protocol unavailable");
  const attachedClient = client;
  const attachedProtocol = protocol;
  let disposed = false;
  return {
    services: new RemoteServiceAccess(attachedClient),
    dispose() {
      if (disposed) return;
      disposed = true;
      attachedClient.dispose();
      attachedProtocol.dispose();
      ws.close();
      data.dispose();
      close.dispose();
    },
  };
}
