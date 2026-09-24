import WebSocket from "ws";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";

export interface HostAttachmentTicket {
  websocketUrl: string;
  ticket: string;
  expiresAt: number;
}

/** Window close only closes this socket; the target Supervisor/Core and accepted commands stay alive. */
export async function openTargetHostSocket(
  attachment: HostAttachmentTicket,
  onSocketCreated?: (socket: WebSocket) => void,
): Promise<WebSocket> {
  const url = new URL(attachment.websocketUrl);
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/ws/host" ||
    url.username ||
    url.password
  ) {
    throw new Error("Trusted Host attachment requires a loopback tunnel");
  }
  if (attachment.expiresAt <= Date.now()) throw new Error("Host ticket expired");
  const socket = new WebSocket(url, {
    headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: attachment.ticket },
    handshakeTimeout: 10_000,
  });
  try {
    // Core 可在 upgrade 后立即发送 RPC Initialize；必须在等待 open 之前接好
    // SocketProtocol/ChannelClient，否则第一帧丢失后所有请求会无限等初始化。
    onSocketCreated?.(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}
