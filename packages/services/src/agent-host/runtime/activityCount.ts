export interface ExternalActivityFact {
  readonly state: "idle" | "busy" | "unknown";
}

/**
 * 外部 AgentHost 的忙碌数。客户端连接数不是输入：断线不能把 unknown/busy 收成 idle。
 * `unknown` 与索引失败的 sentinel 都算忙碌，避免空的 native tracker 把 Supervisor 报成空闲。
 */
export function countRunningTasks(input: {
  readonly nativeActiveSessions: number;
  readonly external: readonly ExternalActivityFact[];
  readonly externalUncertain: boolean;
}): number {
  let externalBusy = 0;
  for (const session of input.external) {
    if (session.state !== "idle") externalBusy += 1;
  }
  return input.nativeActiveSessions + externalBusy + (input.externalUncertain ? 1 : 0);
}
