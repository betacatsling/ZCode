import { once } from "node:events";
import {
  ChannelClient,
  Emitter,
  ProxyChannel,
  SocketProtocol,
  VSBuffer,
  type ISocket,
} from "@zcode/rpc";
import {
  IAgentHostService,
  IProjectCatalogRpcService,
  type ProjectCatalogRpcService,
  type IAgentHostService as AgentHostService,
} from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER, type ServerRemoteHostCapability } from "@zcode/shared";
import WebSocket from "ws";

/** Actual installed Core's one-use Host admission port, not an injected test authority. */
export async function connectInstalledHost(
  host: string,
  port: number,
): Promise<{
  host: AgentHostService;
  catalog: ProjectCatalogRpcService;
  close(): Promise<void>;
}> {
  const response = await fetch(`http://${host}:${port}/api/rpc-host-capability`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(`installed Core capability rejected: ${response.status}`);
  const { capability } = (await response.json()) as ServerRemoteHostCapability;
  if (!capability) throw new Error("installed Core omitted Host capability");
  const ws = new WebSocket(`ws://${host}:${port}/ws/host`, {
    headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability },
  });
  try {
    await once(ws, "open");
  } catch (error) {
    ws.terminate();
    throw error;
  }
  const data = new Emitter<VSBuffer>();
  const closed = new Emitter<void>();
  ws.on("message", (raw: Buffer) => data.fire(VSBuffer.wrap(raw)));
  ws.on("close", () => closed.fire());
  ws.on("error", () => closed.fire());
  const socket: ISocket = {
    onData: data.event,
    onClose: closed.event,
    onEnd: closed.event,
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
  return {
    host: ProxyChannel.toService<AgentHostService>(
      client.getChannel(IAgentHostService.channelName),
    ),
    catalog: ProxyChannel.toService<ProjectCatalogRpcService>(
      client.getChannel(IProjectCatalogRpcService.channelName),
    ),
    async close() {
      client.dispose();
      protocol.dispose();
      ws.close();
      data.dispose();
      closed.dispose();
    },
  };
}
