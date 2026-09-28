import {
  MODEL_GATEWAY_GRANT_LIFETIME_MS,
  MODEL_GATEWAY_TURN_LEASE_MAX_MS,
  MODEL_GATEWAY_TURN_LEASE_RENEW_INTERVAL_MS,
  TargetModelGateway,
  type TargetModelGatewayOptions,
} from "@zcode/services/model-gateway";

export const CODEX_GRANT_LIFETIME_MS = MODEL_GATEWAY_GRANT_LIFETIME_MS;
export const CODEX_TURN_LEASE_MAX_MS = MODEL_GATEWAY_TURN_LEASE_MAX_MS;
export const CODEX_TURN_LEASE_RENEW_INTERVAL_MS = MODEL_GATEWAY_TURN_LEASE_RENEW_INTERVAL_MS;
export type CodexTargetGatewayOptions = TargetModelGatewayOptions;

/** Backward-compatible name while Codex and Claude share the target Gateway owner. */
export class CodexTargetGateway extends TargetModelGateway {}
