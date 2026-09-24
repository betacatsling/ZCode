import { serverRemoteHostCapabilitySchema, serverRemoteInfoSchema } from "@zcode/shared";
import type { RemoteEnvironment, StdioStream } from "./backend.js";

/** Existing SSH backend is transport only; closing this handle never stops the installed Core. */
export interface SshCoreAttachment {
  serverId: string;
  websocketUrl: string;
  ticket: string;
  expiresAt: number;
  dispose(): void;
}

export interface SshCoreAttachmentTransport {
  detect(): Promise<RemoteEnvironment>;
  exec(command: string): Promise<StdioStream>;
  openLoopbackTunnel(port: number): Promise<{ endpoint: string; dispose(): void }>;
}

interface ExpectedTarget {
  serverId: string;
  version: string;
}

/**
 * Short exec starts/reuses the installed persistent Core, then opens a disposable SSH forward.
 * No task IDs or Harness state are stored by this connector. The ticket is single-use: caller
 * must upgrade /ws/host immediately; failures require a fresh handshake, not a reused ticket.
 */
export async function attachInstalledSshCore(
  backend: SshCoreAttachmentTransport,
  expected: ExpectedTarget,
): Promise<SshCoreAttachment> {
  if (!expected.serverId?.trim() || !expected.version?.trim()) {
    throw new Error("Target identity and version are required for SSH Host attachment");
  }
  const env = await backend.detect();
  if (env.platform !== "linux" || !["x64", "arm64"].includes(env.arch)) {
    throw new Error("SSH Core attachment requires packaged linux-x64/arm64 runtime");
  }
  // Fixed argv; no workspace, secret, shell fragment or caller-provided path reaches remote exec.
  const stream = await backend.exec('"$HOME/.zcode/server/bin/zcode" serve --daemon --json');
  const stdout = await collectShortExec(stream);
  let status: unknown;
  try {
    status = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    throw new Error("Installed Core did not return a JSON ready receipt");
  }
  if (
    !status ||
    typeof status !== "object" ||
    !("state" in status) ||
    status.state !== "ready" ||
    !("host" in status) ||
    status.host !== "127.0.0.1" ||
    !("port" in status) ||
    !Number.isInteger(status.port) ||
    (status.port as number) < 1 ||
    (status.port as number) > 65535 ||
    !("version" in status) ||
    status.version !== expected.version
  ) {
    throw new Error("Installed Core ready receipt does not match expected loopback/version");
  }
  const tunnel = await backend.openLoopbackTunnel(status.port as number);
  try {
    const origin = new URL(tunnel.endpoint);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/"
    ) {
      throw new Error("SSH tunnel endpoint must be local loopback");
    }
    const infoResponse = await fetch(`${origin.origin}/api/server-info`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!infoResponse.ok) throw new Error("SSH target info unavailable");
    const info = serverRemoteInfoSchema.parse(await infoResponse.json());
    if (
      info.serverId !== expected.serverId ||
      info.version !== expected.version ||
      info.capabilities.agentHost !== true ||
      info.capabilities.desktopContinuous !== true
    ) {
      throw new Error("SSH target identity/version/Host capability mismatch");
    }
    const ticketResponse = await fetch(`${origin.origin}/api/rpc-host-capability`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    if (!ticketResponse.ok) throw new Error("SSH target ticket unavailable");
    const ticket = serverRemoteHostCapabilitySchema.parse(await ticketResponse.json());
    if (ticket.expiresAt <= Date.now()) throw new Error("SSH target ticket expired");
    return {
      serverId: info.serverId,
      websocketUrl: `${origin.origin.replace(/^http:/u, "ws:")}/ws/host`,
      ticket: ticket.capability,
      expiresAt: ticket.expiresAt,
      dispose: tunnel.dispose,
    };
  } catch (error) {
    tunnel.dispose();
    throw error;
  }
}

async function collectShortExec(stream: StdioStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("SSH Core bootstrap timed out")), 10_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    }
    stream.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 64 * 1024) finish(new Error("SSH Core bootstrap receipt too large"));
    });
    stream.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 8 * 1024) stderr = stderr.slice(0, 8 * 1024);
    });
    stream.onClose((code) =>
      finish(code === 0 ? undefined : new Error(`SSH Core bootstrap failed (${code}): ${stderr}`)),
    );
    stream.stdin.end();
  });
}
