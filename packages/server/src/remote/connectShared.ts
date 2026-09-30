// Shared connect types, the backend-disconnect exit code and abort helpers (moved from connect.ts).
import type { ChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { DeployOptions } from "./deploy.js";

export const BACKEND_DISCONNECT_EXIT_CODE = -1;

export interface ConnectOptions extends DeployOptions {
  /** Client identifier for handshake */
  clientId?: string;
  /** Handshake timeout in ms (default: 10000) */
  handshakeTimeout?: number;
  /** Skip deploy step (assume server is already deployed) */
  skipDeploy?: boolean;
  /** 桌面 app 版本；用于透传给远端 agent，让模型请求 header 能标识发起方版本 */
  appVersion?: string;
  /** 远端 server/agent 需要继承的非敏感产品环境变量；调用方可传较宽的 env，server 侧会按白名单过滤。 */
  remoteRuntimeEnv?: Record<string, string | undefined>;
  /** Desktop Host 为 desktop-attached WSL server 提供的显式 Agent 网络配置。 */
  remoteRuntimeNetwork?: RemoteRuntimeNetworkOptions;
  /** 远端 stdio 关闭后的回调（用于上层感知断连并触发回收） */
  onDidRemoteClose?: (event: { code: number }) => void;
  /** Main-generated, content-addressed runtime archives; consumed only by SSH targets. */
  persistentTargetRuntimeArchives?: Readonly<Record<string, string>>;
}

export interface RemoteRuntimeNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  /** 只允许 Host 设置权威值覆盖远端自身的旧设置。 */
  authoritative?: boolean;
}

export interface RemoteConnection {
  services: IServiceAccessor;
  client: ChannelClient;
  /** Stable installation identity reported by a persistent Server Core. */
  targetId?: string;
  dispose(): void;
  disposeAndWait(options?: { timeoutMs?: number }): Promise<void>;
}

export function createRemoteConnectAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Remote connection canceled");
  error.name = "AbortError";
  return error;
}

export function throwIfRemoteConnectAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createRemoteConnectAbortError(signal);
  }
}
