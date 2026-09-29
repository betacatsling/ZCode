import { ChannelClient, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import WebSocket from "ws";

export interface PersistentTargetClientOptions {
  host: string;
  port: number;
  expectedTargetId?: string;
  /**
   * Private per-Core bootstrap secret from the Supervisor status (`hostBootstrapToken`), obtained
   * over a private channel (local `serve --json` stdout or the SSH exec channel). Required by Cores
   * that enforce bootstrap auth; older Cores ignore it.
   */
  hostBootstrapToken?: string;
  signal?: AbortSignal;
  onDidClose?: (event: { code: number; reason: string }) => void;
}

export interface PersistentTargetConnection {
  services: RemoteServiceAccess;
  client: ChannelClient;
  targetId: string;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

function assertLoopbackHost(host: string): void {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (normalized !== "127.0.0.1" && normalized !== "::1" && normalized !== "localhost") {
    throw new Error("Persistent target attachment must use a loopback endpoint");
  }
}

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  ws.on("message", (raw) => {
    const bytes = Buffer.isBuffer(raw)
      ? raw
      : Array.isArray(raw)
        ? Buffer.concat(raw)
        : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(bytes));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(buffer.buffer));
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
}

async function requestHostCapability(
  baseUrl: URL,
  expectedTargetId: string | undefined,
  hostBootstrapToken: string | undefined,
  signal?: AbortSignal,
): Promise<{ capability: string; targetId: string }> {
  const serverInfoResponse = await fetch(new URL("/api/server-info", baseUrl), { signal });
  if (!serverInfoResponse.ok) {
    throw new Error(`Persistent target information request failed (${serverInfoResponse.status})`);
  }
  const serverInfo: unknown = await serverInfoResponse.json();
  if (
    typeof serverInfo !== "object" ||
    serverInfo === null ||
    !("serverId" in serverInfo) ||
    typeof serverInfo.serverId !== "string" ||
    !("capabilities" in serverInfo) ||
    typeof serverInfo.capabilities !== "object" ||
    serverInfo.capabilities === null ||
    !("agentHost" in serverInfo.capabilities) ||
    serverInfo.capabilities.agentHost !== true
  ) {
    throw new Error("Persistent target does not expose the required AgentHost services");
  }
  const targetId = serverInfo.serverId;
  if (expectedTargetId && targetId !== expectedTargetId) {
    throw new Error("Persistent target identity does not match the expected target");
  }
  const response = await fetch(new URL("/api/rpc-host-capability", baseUrl), {
    method: "POST",
    headers: hostBootstrapToken ? { authorization: `Bearer ${hostBootstrapToken}` } : {},
    signal,
  });
  if (!response.ok)
    throw new Error(`Persistent target capability request failed (${response.status})`);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("capability" in body) ||
    typeof body.capability !== "string" ||
    body.capability.length === 0
  ) {
    throw new Error("Persistent target returned an invalid host capability");
  }
  return { capability: body.capability, targetId };
}

function waitForOpen(ws: WebSocket, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onCloseBeforeOpen);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Persistent target WebSocket connection failed"));
    const onCloseBeforeOpen = (code: number, reason: Buffer) =>
      finish(
        new Error(
          reason.length > 0
            ? `Persistent target WebSocket closed before ready (${code}: ${reason.toString()})`
            : `Persistent target WebSocket closed before ready (${code})`,
        ),
      );
    const onAbort = () => {
      ws.close();
      finish(
        signal?.reason instanceof Error ? signal.reason : new Error("Target attachment canceled"),
      );
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onCloseBeforeOpen);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Attach one trusted desktop Host to the existing target Core; disposal closes only this RPC scope. */
export async function connectToPersistentTarget(
  options: PersistentTargetClientOptions,
): Promise<PersistentTargetConnection> {
  assertLoopbackHost(options.host);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Persistent target port is invalid");
  }
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("Target attachment canceled");
  }
  const normalizedHost = options.host.replace(/^\[|\]$/gu, "");
  const authorityHost = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  const baseUrl = new URL(`http://${authorityHost}:${options.port}`);
  const { capability, targetId } = await requestHostCapability(
    baseUrl,
    options.expectedTargetId,
    options.hostBootstrapToken,
    options.signal,
  );
  const wsUrl = new URL("/ws/host", baseUrl);
  wsUrl.protocol = "ws:";
  const ws = new WebSocket(wsUrl, {
    headers: { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability },
  });
  try {
    await waitForOpen(ws, options.signal);
  } catch (error) {
    ws.terminate();
    throw error;
  }
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const services = new RemoteServiceAccess(client);
  let disposed = false;
  const closed = new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
  ws.once("close", (code, reason) => {
    options.onDidClose?.({ code, reason: reason.toString() });
  });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    client.dispose();
    protocol.dispose();
    ws.terminate();
  };
  return {
    services,
    client,
    targetId,
    dispose,
    async disposeAndWait() {
      dispose();
      await closed;
    },
  };
}
