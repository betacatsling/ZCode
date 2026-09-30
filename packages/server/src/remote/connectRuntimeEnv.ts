// Remote runtime env allow-list, WSL proxy resolution and the stdio launch command (moved from connect.ts).
import {
  SERVICE_AUTHORITY_MODE_ENV,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import { quotePosixShellArg } from "./posixShell.js";
import { formatWslProxyForLog } from "./wslProxy.js";
import type { ConnectOptions, RemoteRuntimeNetworkOptions } from "./connectShared.js";

const REMOTE_RUNTIME_ENV_KEYS = [
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZAI_OAUTH_ORIGIN",
  "ZAI_BUSINESS_BASE_URL",
  "ZAI_OAUTH_CLIENT_ID",
  // 由 Desktop Main 计算并下发；远端 server 只消费，不重新计算。
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  // 同上：本地覆盖由 Desktop Main 按构建档位写定（buildHostProcessEnv），
  // 透传后 SSH/WSL/Docker 远端 Host 与本地 Host 得到同一档位。
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
] as const;

export type RemoteRuntimeEnvKey = (typeof REMOTE_RUNTIME_ENV_KEYS)[number];
export type RemoteRuntimeEnv = Partial<Record<RemoteRuntimeEnvKey, string>>;

export function pickRemoteRuntimeEnv(env: Record<string, string | undefined>): RemoteRuntimeEnv {
  const picked: RemoteRuntimeEnv = {};
  for (const key of REMOTE_RUNTIME_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }
  return picked;
}

export async function resolveRemoteRuntimeNetwork(
  backend: IRemoteBackend,
  network: RemoteRuntimeNetworkOptions | undefined,
  log: (...args: unknown[]) => void,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (!network || !backend.resolveRuntimeProxy) {
    // 只有实现了远端代理解析能力的 WSL backend 才接收这条权威网络边界；
    // SSH/Docker 即使误传 options 也保持原有启动命令。
    return undefined;
  }
  if (!network.httpProxy?.trim()) {
    return network;
  }

  try {
    const resolvedProxy = await backend.resolveRuntimeProxy(network.httpProxy);
    if (resolvedProxy !== network.httpProxy) {
      log(
        "resolved remote runtime proxy via wsl-host-gateway",
        formatWslProxyForLog(network.httpProxy),
        "->",
        formatWslProxyForLog(resolvedProxy),
      );
    }
    return { ...network, httpProxy: resolvedProxy };
  } catch (error) {
    // 代理解析只是运行时增强；解析失败时沿用设置页原值，避免把 WSL 本地工作区变成不可连接。
    log(
      "remote runtime proxy resolution failed; using configured endpoint",
      error instanceof Error ? error.message : String(error),
    );
    return network;
  }
}

export function buildRemoteServerCommand(
  options: ConnectOptions | undefined,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
): string {
  const envParts = [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    'ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"',
  ];
  for (const [key, value] of Object.entries(
    pickRemoteRuntimeEnv(options?.remoteRuntimeEnv ?? {}),
  )) {
    envParts.push(`${key}=${quotePosixShellArg(value)}`);
  }
  const appVersion = options?.appVersion?.trim();
  if (appVersion) {
    // 远端 server 是通过 SSH/WSL/Docker 单独启动的，不会继承桌面 host env。
    // 这里显式把 app 版本作为远端进程 env 注入，远端 agent 才能在模型请求 header 中带上版本。
    envParts.push(`${ZCODE_APP_VERSION_ENV}=${quotePosixShellArg(appVersion)}`);
  }
  if (remoteRuntimeNetwork?.authoritative) {
    envParts.push(`${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1'`);
    if (remoteRuntimeNetwork.httpProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.httpProxy)}`,
      );
    }
    if (remoteRuntimeNetwork.noProxy !== undefined) {
      envParts.push(
        `${ZCODE_REMOTE_NO_PROXY_ENV_KEY}=${quotePosixShellArg(remoteRuntimeNetwork.noProxy)}`,
      );
    }
  }
  return `${envParts.join(" ")} ~/.zcode/server/node ~/.zcode/server/zcode-server.cjs`;
}
