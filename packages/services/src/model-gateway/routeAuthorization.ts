import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Model, ModelOptions } from "@zcode/contracts";
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
  readonly model: Model;
  readonly streamText: Model["streamText"];
  readonly modelOptions: Readonly<ModelOptions>;
  reservedGenerationTokens: number;
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
    !positive(binding.maxOutputBytes) ||
    !positive(binding.maxGenerationTokens) ||
    !positive(binding.maxOutputTokensPerRequest)
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
    for (const [key, values] of Object.entries(protocol.allowedQueryParameters ?? {})) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) ||
        /^(?:key|token|api_key|authorization|access_token)$/i.test(key) ||
        !values.length ||
        values.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value)) ||
        new Set(values).size !== values.length
      )
        throw new GatewayError(400, "invalid_route");
    }
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
  return state;
}

export function routeForRawUrl(
  rawUrl: string,
  routes: Map<string, GatewayProtocolAdapter>,
): GatewayProtocolAdapter {
  if (rawUrl.includes("#")) throw new GatewayError(400, "invalid_transport");
  const separator = rawUrl.indexOf("?");
  const protocol = routes.get(separator < 0 ? rawUrl : rawUrl.slice(0, separator));
  if (!protocol) throw new GatewayError(404, "unsupported_endpoint");
  if (separator >= 0) {
    const query = rawUrl.slice(separator + 1);
    const seen = new Set<string>();
    for (const pair of query.split("&")) {
      const delimiter = pair.indexOf("=");
      if (delimiter < 1 || pair.indexOf("=", delimiter + 1) >= 0)
        throw new GatewayError(400, "invalid_transport");
      const key = pair.slice(0, delimiter);
      const value = pair.slice(delimiter + 1);
      if (
        seen.has(key) ||
        !Object.hasOwn(protocol.allowedQueryParameters ?? {}, key) ||
        !protocol.allowedQueryParameters?.[key]?.includes(value)
      )
        throw new GatewayError(400, "invalid_transport");
      seen.add(key);
    }
  }
  return protocol;
}

export function reserveGeneration(
  state: TokenState,
  options: ModelOptions | undefined,
): ModelOptions {
  const requested = options?.maxOutputTokens;
  if (
    options?.reasoningLevel !== undefined &&
    options.reasoningLevel !== state.modelOptions.reasoningLevel
  )
    throw new GatewayError(422, "model_options_mismatch");
  if (
    requested !== undefined &&
    (!Number.isSafeInteger(requested) ||
      requested <= 0 ||
      requested > state.binding.maxOutputTokensPerRequest)
  )
    throw new GatewayError(422, "invalid_output_tokens");
  const remaining = state.binding.maxGenerationTokens - state.reservedGenerationTokens;
  if (remaining <= 0 || (requested !== undefined && requested > remaining))
    throw new GatewayError(429, "generation_budget_exceeded");
  const maxOutputTokens = requested ?? Math.min(state.binding.maxOutputTokensPerRequest, remaining);
  // 中文修复依据：先为并发调用预留最大可生成量，失败也不退款，避免实际用量异步回报造成超售。
  state.reservedGenerationTokens += maxOutputTokens;
  return { ...state.modelOptions, maxOutputTokens };
}
