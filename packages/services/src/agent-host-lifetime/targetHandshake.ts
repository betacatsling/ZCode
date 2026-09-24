import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
} from "@zcode/shared";

export interface TargetAttachmentTicket {
  serverId: string;
  websocketUrl: string;
  ticket: string;
  expiresAt: number;
}

/** Only accepts a trusted loopback endpoint (local or an authenticated SSH forward). */
export async function prepareTargetAttachment(
  endpoint: string,
  expectedServerId: string,
  readInfo: (endpoint: string) => Promise<unknown> = async (url) => {
    const response = await fetch(`${url}/api/server-info`);
    if (!response.ok) throw new Error("Target info unavailable");
    return await response.json();
  },
  expectedVersion?: string,
): Promise<TargetAttachmentTicket> {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new Error("Target attachment requires a loopback HTTP/SSH tunnel endpoint");
  }
  const rawInfo = await readInfo(url.origin);
  if (
    typeof rawInfo !== "object" ||
    rawInfo === null ||
    !("protocolVersion" in rawInfo) ||
    rawInfo.protocolVersion !== SERVER_REMOTE_PROTOCOL_VERSION
  ) {
    throw new Error("Target protocol mismatch");
  }
  const info = serverRemoteInfoSchema.parse(rawInfo);
  if (info.serverId !== expectedServerId) throw new Error("Target identity mismatch");
  if (expectedVersion !== undefined && info.version !== expectedVersion) {
    throw new Error("Target version mismatch");
  }
  if (info.capabilities.agentHost !== true || info.capabilities.desktopContinuous !== true) {
    throw new Error("Target does not support trusted Host attachment");
  }
  const response = await fetch(`${url.origin}/api/rpc-host-capability`, { method: "POST" });
  if (!response.ok) throw new Error("Target Host capability unavailable");
  const ticket = serverRemoteHostCapabilitySchema.parse(await response.json());
  if (ticket.expiresAt <= Date.now()) throw new Error("Target Host capability expired");
  // Ticket is one-use; caller must immediately upgrade /ws/host and discard it after failure.
  return {
    serverId: info.serverId,
    websocketUrl: `${url.origin.replace(/^http:/u, "ws:")}/ws/host`,
    ticket: ticket.capability,
    expiresAt: ticket.expiresAt,
  };
}
