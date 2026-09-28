import {
  MODEL_GATEWAY_GRANT_LIFETIME_MS,
  MODEL_GATEWAY_TURN_LEASE_MAX_MS,
  MODEL_GATEWAY_TURN_LEASE_RENEW_INTERVAL_MS,
  TargetModelGateway,
  type TargetModelGatewayOptions,
  type TargetModelGatewayPort,
} from "@zcode/services/model-gateway";

export const CODEX_GRANT_LIFETIME_MS = MODEL_GATEWAY_GRANT_LIFETIME_MS;
export const CODEX_TURN_LEASE_MAX_MS = MODEL_GATEWAY_TURN_LEASE_MAX_MS;
export const CODEX_TURN_LEASE_RENEW_INTERVAL_MS = MODEL_GATEWAY_TURN_LEASE_RENEW_INTERVAL_MS;
export type CodexTargetGatewayOptions = TargetModelGatewayOptions;

/** Backward-compatible name for the per-adapter default while a shared owner is absent. */
export class CodexTargetGateway extends TargetModelGateway {}

/**
 * 优先使用宿主注入的共享 TargetModelGateway。
 * 未注入时才自建 CodexTargetGateway，并由适配器在 shutdown 时关闭它。
 * 注入的 owner 由目标 Core 关闭；SSH 隧道断开不能在这里被当成 teardown。
 */
export function resolveCodexTargetGateway(input: {
  readonly injected?: TargetModelGatewayPort;
  readonly now?: () => number;
}): { readonly gateway: TargetModelGatewayPort; readonly ownsGateway: boolean } {
  if (input.injected) return { gateway: input.injected, ownsGateway: false };
  return {
    gateway: new CodexTargetGateway(input.now ? { now: input.now } : {}),
    ownsGateway: true,
  };
}
