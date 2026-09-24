import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import type { GatewayProtocolAdapter, GatewayProtocolId, GatewayTokenBinding } from "./contract.js";

export class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface TokenState {
  readonly binding: Readonly<GatewayTokenBinding>;
  requests: number;
  outputBytes: number;
  readonly active: Set<AbortController>;
  timer?: NodeJS.Timeout;
}
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
export function validateBinding(binding: GatewayTokenBinding): void {
  if (
    [
      binding.targetId,
      binding.hostSessionId,
      binding.runtimeEpoch,
      binding.turnId,
      binding.requestedModelAlias,
      binding.effectiveSelection?.providerId,
      binding.effectiveSelection?.modelId,
    ].some((value) => typeof value !== "string" || !value.trim()) ||
    !modelSelectionSchema.safeParse(binding.effectiveSelection).success ||
    !positive(binding.expiresAt) ||
    binding.expiresAt <= Date.now() ||
    !positive(binding.maxRequests) ||
    !positive(binding.maxOutputBytes)
  ) {
    throw new GatewayError(400, "invalid_binding");
  }
}
export function validateProtocols(
  protocols: readonly GatewayProtocolAdapter[],
): Map<string, GatewayProtocolAdapter> {
  const paths = new Map<string, GatewayProtocolAdapter>();
  for (const protocol of protocols) {
    if (protocol.id !== "responses" && protocol.id !== "anthropic-messages")
      throw new GatewayError(400, "invalid_protocol");
    for (const path of protocol.paths) {
      if (!/^\/[a-zA-Z0-9/_-]+$/.test(path) || paths.has(path))
        throw new GatewayError(400, "invalid_route");
      paths.set(path, protocol);
    }
  }
  return paths;
}
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}
export function authorize(
  req: IncomingMessage,
  tokens: Map<string, TokenState>,
  protocol: GatewayProtocolId,
): TokenState {
  const authorization = req.headers.authorization;
  const apiKey = req.headers["x-api-key"];
  if (typeof authorization !== "string" && typeof apiKey !== "string")
    throw new GatewayError(401, "unauthorized");
  if (authorization && apiKey) throw new GatewayError(401, "unauthorized");
  const token = authorization
    ? authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : undefined
    : apiKey;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new GatewayError(401, "unauthorized");
  // Compare against every live token with constant-time equality; never include a credential in errors/observations.
  let state: TokenState | undefined;
  const candidate = Buffer.from(token);
  for (const [key, entry] of tokens) {
    if (timingSafeEqual(candidate, Buffer.from(key))) state = entry;
  }
  if (!state || state.binding.expiresAt <= Date.now()) throw new GatewayError(401, "unauthorized");
  if (state.binding.protocol !== protocol) throw new GatewayError(403, "protocol_mismatch");
  if (state.requests >= state.binding.maxRequests)
    throw new GatewayError(429, "request_budget_exceeded");
  return state;
}
