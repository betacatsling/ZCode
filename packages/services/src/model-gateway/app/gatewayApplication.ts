import type {
  CreateModelGatewayOptions,
  ModelGatewayErrorBody,
  ModelGatewayErrorCode,
  ModelGatewayGrant,
  ModelGatewayGrantInput,
  ModelGatewayProtocol,
} from "../contract.js";
import { modelGatewayLimitsSchema, modelGatewayProtocolSchema } from "../contract.js";
import { ModelGatewayProtocolError } from "../domain/errors.js";
import { decodeResponsesRequest } from "../domain/responsesDecoder.js";
import type {
  GatewayHttpHandler,
  GatewayHttpRequest,
  GatewayHttpResponse,
  GatewayTokenPort,
} from "./transport.js";
import { parseResponsesJson } from "./responsesHttpEncoding.js";
import { streamGatewayModelResponse, type GatewayGrantRecord } from "./modelResponseStream.js";
import { decodeMessagesRequest, parsePinnedAnthropicBetaHeader } from "../domain/messagesDecoder.js";
import { parseMessagesJson } from "./messagesHttpEncoding.js";
import { streamGatewayMessagesResponse } from "./messagesResponseStream.js";

class GatewayFailure extends Error {
  constructor(
    readonly code: ModelGatewayErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function errorType(code: ModelGatewayErrorCode): ModelGatewayErrorBody["error"]["type"] {
  if (code === "unauthorized") return "authentication_error";
  if (code === "invalid_request" || code === "unsupported_feature") return "invalid_request_error";
  return "server_error";
}

function errorResponse(
  code: ModelGatewayErrorCode,
  status: number,
  message: string,
): GatewayHttpResponse {
  const body: ModelGatewayErrorBody = { error: { type: errorType(code), code, message } };
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

function failure(code: ModelGatewayErrorCode, status: number, message: string): never {
  throw new GatewayFailure(code, status, message);
}

function parseBearer(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(value);
  return match?.[1];
}

function parseCapability(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[A-Za-z0-9_-]{40,64}$/.test(value) ? value : undefined;
}

function anthropicErrorResponse(
  code: ModelGatewayErrorCode,
  status: number,
  message: string,
): GatewayHttpResponse {
  const type =
    code === "unauthorized"
      ? "authentication_error"
      : code === "rate_limited"
        ? "rate_limit_error"
        : code === "unavailable" || code === "model_error"
          ? "api_error"
          : "invalid_request_error";
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify({ type: "error", error: { type, message } }),
  };
}

async function readBody(request: GatewayHttpRequest, limit: number): Promise<string> {
  if (request.contentLength !== undefined) {
    if (!/^\d+$/.test(request.contentLength))
      failure("invalid_request", 400, "Content-Length is invalid");
    if (Number(request.contentLength) > limit)
      failure("payload_too_large", 413, "Request body exceeds the session limit");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request.body) {
    if (request.signal.aborted) failure("invalid_request", 400, "Request was cancelled");
    length += chunk.byteLength;
    if (length > limit) failure("payload_too_large", 413, "Request body exceeds the session limit");
    chunks.push(chunk);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  ).toString("utf8");
}

export class GatewayApplication implements GatewayHttpHandler {
  private readonly grants = new Map<string, GatewayGrantRecord>();
  private readonly grantsById = new Map<string, GatewayGrantRecord>();
  private readonly sessions = new Map<string, string>();
  private activeRequests = 0;
  private closed = false;
  private baseUrl: string | undefined;

  constructor(
    private readonly options: CreateModelGatewayOptions,
    private readonly tokenPort: GatewayTokenPort,
    private readonly now: () => number = Date.now,
  ) {}

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  createGrant(input: ModelGatewayGrantInput): ModelGatewayGrant {
    if (this.closed || !this.baseUrl)
      throw new Error("Model Gateway must be started before grants are issued");
    const limits = modelGatewayLimitsSchema.parse(input.limits);
    if (!input.sessionId.trim() || input.sessionId.length > 256)
      throw new Error("sessionId must be a bounded non-empty string");
    if (!input.modelBindingFingerprint.trim() || input.modelBindingFingerprint.length > 512) {
      throw new Error("modelBindingFingerprint must be a bounded non-empty string");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.publicModelId))
      throw new Error("publicModelId is invalid");
    if (!input.model.providerId || !input.model.modelId)
      throw new Error("bound Model must expose its actual Provider and model identity");
    if (
      !Number.isSafeInteger(input.expiresInMs) ||
      input.expiresInMs < 1 ||
      input.expiresInMs > (this.options.maxGrantLifetimeMs ?? 10 * 60_000)
    ) {
      throw new Error("grant lifetime exceeds the configured short-lived limit");
    }
    const selectedReasoning = input.model.options.reasoningLevel;
    if (
      input.protocol === "openai-responses" &&
      !(selectedReasoning === "none" || selectedReasoning === "off" || selectedReasoning === "disabled")
    ) {
      throw new Error(
        "bound Model must be configured with reasoning disabled for this Responses slice",
      );
    }
    if (
      input.protocol === "anthropic-messages" &&
      !["low", "medium", "high", "xhigh", "max"].includes(selectedReasoning ?? "")
    ) {
      throw new Error("bound Model must expose the pinned Claude effort level for Messages");
    }
    const modelOutputLimit = input.model.optionSpecs.maxOutputTokens.max;
    if (!Number.isSafeInteger(modelOutputLimit) || modelOutputLimit < 1) {
      throw new Error("bound Model must expose a finite output-token limit");
    }
    const existingGrantId = this.sessions.get(input.sessionId);
    const existingGrant = existingGrantId ? this.grantsById.get(existingGrantId) : undefined;
    if (
      existingGrant &&
      existingGrant.expiresAt <= this.now() &&
      (!existingGrant.turnLease || existingGrant.turnLease.expiresAt <= this.now())
    ) {
      this.revoke(existingGrant.id);
    }
    if (this.sessions.has(input.sessionId))
      throw new Error("a session can have only one active Model Gateway grant");
    const token = this.tokenPort.createOpaqueToken();
    const digest = this.tokenPort.digestToken(token);
    if (this.grants.has(digest)) throw new Error("Gateway token collision");
    const id = this.tokenPort.createResponseId().replace(/^resp_/, "grant_");
    const expiresAt = this.now() + input.expiresInMs;
    const record: GatewayGrantRecord = {
      id,
      digest,
      sessionId: input.sessionId,
      protocol: input.protocol,
      modelBindingFingerprint: input.modelBindingFingerprint,
      publicModelId: input.publicModelId,
      model: input.model,
      expiresAt,
      limits,
      revoked: new AbortController(),
      requestCount: 0,
      activeCount: 0,
      usedOutputTokens: 0,
      reservedOutputTokens: 0,
    };
    this.grants.set(digest, record);
    this.grantsById.set(id, record);
    this.sessions.set(input.sessionId, id);
    return {
      id,
      token,
      baseUrl: this.baseUrl,
      protocol: modelGatewayProtocolSchema.parse(input.protocol),
      sessionId: input.sessionId,
      modelBindingFingerprint: input.modelBindingFingerprint,
      actualModel: {
        providerId: input.model.providerId,
        modelId: input.model.modelId,
      },
      publicModelId: input.publicModelId,
      expiresAt,
    };
  }

  renewGrant(
    grantId: string,
    input: { readonly expectedModelBindingFingerprint: string; readonly expiresInMs: number },
  ): { readonly expiresAt: number } {
    const record = this.#requireGrant(grantId);
    if (record.modelBindingFingerprint !== input.expectedModelBindingFingerprint)
      throw new Error("Model Gateway grant renewal cannot change its binding");
    if (
      !Number.isSafeInteger(input.expiresInMs) ||
      input.expiresInMs < 1 ||
      input.expiresInMs > (this.options.maxGrantLifetimeMs ?? 10 * 60_000)
    ) {
      throw new Error("Model Gateway grant renewal exceeds its bounded lifetime");
    }
    record.expiresAt = this.now() + input.expiresInMs;
    return { expiresAt: record.expiresAt };
  }

  beginTurnLease(grantId: string, turnId: string): { readonly expiresAt: number } {
    const record = this.#requireGrant(grantId);
    if (!turnId.trim() || turnId.length > 256)
      throw new Error("Model Gateway turn lease requires a bounded Host turn ID");
    if (record.expiresAt <= this.now())
      throw new Error("expired Model Gateway grant must be renewed before a turn lease");
    if (record.turnLease && record.turnLease.expiresAt <= this.now()) delete record.turnLease;
    if (record.turnLease) {
      if (record.turnLease.turnId === turnId) return { expiresAt: record.turnLease.expiresAt };
      throw new Error("Model Gateway grant already has another active turn lease");
    }
    const expiresAt = this.now() + (this.options.maxTurnLeaseMs ?? 5 * 60_000);
    record.turnLease = { turnId, expiresAt };
    return { expiresAt };
  }

  renewTurnLease(grantId: string, turnId: string): { readonly expiresAt: number } {
    const record = this.#requireGrant(grantId);
    if (!record.turnLease || record.turnLease.turnId !== turnId)
      throw new Error("Model Gateway turn lease does not match the active Host turn");
    record.turnLease.expiresAt = this.now() + (this.options.maxTurnLeaseMs ?? 5 * 60_000);
    return { expiresAt: record.turnLease.expiresAt };
  }

  endTurnLease(grantId: string, turnId: string): void {
    const record = this.grantsById.get(grantId);
    if (!record) return;
    if (!record.turnLease || record.turnLease.turnId !== turnId)
      throw new Error("Model Gateway turn lease does not match the active Host turn");
    delete record.turnLease;
  }

  revoke(grantId: string): void {
    const record = this.grantsById.get(grantId);
    if (!record) return;
    this.grants.delete(record.digest);
    this.grantsById.delete(record.id);
    if (this.sessions.get(record.sessionId) === record.id) this.sessions.delete(record.sessionId);
    record.revoked.abort();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const grantId of this.grantsById.keys()) this.revoke(grantId);
  }

  async handle(request: GatewayHttpRequest): Promise<GatewayHttpResponse> {
    if (this.closed) return errorResponse("unavailable", 503, "Model Gateway is closed");
    if (request.path === "/api/hello" && request.method === "HEAD") {
      return {
        status: 200,
        headers: { "cache-control": "no-store", "content-length": "0" },
        body: "",
      };
    }
    const protocol =
      request.path === "/v1/responses"
        ? "openai-responses"
        : request.path === "/v1/messages" || request.path === "/v1/messages?beta=true"
          ? "anthropic-messages"
          : undefined;
    if (!protocol)
      return errorResponse("not_found", 404, "Route is not supported");
    if (request.method !== "POST")
      return protocol === "openai-responses"
        ? errorResponse("method_not_allowed", 405, "Method is not supported")
        : anthropicErrorResponse("method_not_allowed", 405, "Method is not supported");
    let betas: ReadonlySet<string> | undefined;
    if (protocol === "anthropic-messages") {
      if (request.anthropicVersion !== "2023-06-01")
        return anthropicErrorResponse("unsupported_feature", 400, "Anthropic-Version is not supported");
      if (request.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
        return anthropicErrorResponse("invalid_request", 400, "Content-Type must be application/json");
      if (request.anthropicDirectBrowserAccess !== "true")
        return anthropicErrorResponse("unsupported_feature", 400, "Anthropic client header is not supported");
      betas = parsePinnedAnthropicBetaHeader(request.anthropicBeta);
      if (!betas)
        return anthropicErrorResponse("unsupported_feature", 400, "Anthropic beta header is not supported");
    }
    const token =
      protocol === "openai-responses" ? parseBearer(request.authorization) : parseCapability(request.apiKey);
    const record = token ? this.authorize(token, protocol) : undefined;
    if (!record)
      return protocol === "openai-responses"
        ? errorResponse("unauthorized", 401, "Session grant is missing, expired, or revoked")
        : anthropicErrorResponse("unauthorized", 401, "Session grant is missing, expired, or revoked");
    try {
      if (protocol === "anthropic-messages") {
        const body = parseMessagesJson(await readBody(request, record.limits.maxBodyBytes));
        if (!betas) failure("unsupported_feature", 400, "Anthropic beta header is not supported");
        const decoded = decodeMessagesRequest(body, record.publicModelId, record.model, betas);
        if (!this.#isAuthorizedAt(record, this.now()))
          failure("unauthorized", 401, "Session grant or active turn lease has expired");
        if (record.requestCount >= record.limits.maxRequests)
          failure("budget_exceeded", 429, "Session request budget is exhausted");
        if (
          record.activeCount >= record.limits.maxConcurrent ||
          this.activeRequests >= (this.options.maxConcurrent ?? 16)
        ) {
          failure("rate_limited", 429, "Gateway concurrency limit is reached");
        }
        const available =
          record.limits.maxOutputTokens - record.usedOutputTokens - record.reservedOutputTokens;
        const modelLimit = record.model.optionSpecs.maxOutputTokens.max;
        const requestLimit = Math.min(available, record.limits.maxOutputTokensPerRequest, modelLimit);
        if (requestLimit < 1 || decoded.maxOutputTokens > requestLimit)
          failure("budget_exceeded", 429, "Session output-token budget is exhausted");
        record.requestCount += 1;
        record.activeCount += 1;
        record.reservedOutputTokens += decoded.maxOutputTokens;
        this.activeRequests += 1;
        return {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-store",
            connection: "keep-alive",
          },
          body: streamGatewayMessagesResponse({
            record,
            request: decoded,
            reservation: decoded.maxOutputTokens,
            availableAtAdmission: available,
            clientSignal: request.signal,
            now: this.now,
            authorizationExpiry: () => this.#authorizationExpiry(record),
            createResponseId: () => this.tokenPort.createResponseId().replace(/^resp_/, "msg_"),
            onSettled: () => {
              record.activeCount -= 1;
              this.activeRequests -= 1;
            },
          }),
        };
      }
      const body = parseResponsesJson(await readBody(request, record.limits.maxBodyBytes));
      const decoded = decodeResponsesRequest(body, record.publicModelId);
      if (
        record.clientSessionId !== undefined &&
        record.clientSessionId !== decoded.clientSessionId
      ) {
        failure("unauthorized", 401, "Session grant is bound to another Codex session");
      }
      if (record.clientThreadId !== undefined && record.clientThreadId !== decoded.clientThreadId) {
        failure("unauthorized", 401, "Session grant is bound to another Codex thread");
      }
      if (!this.#isAuthorizedAt(record, this.now()))
        failure("unauthorized", 401, "Session grant or active turn lease has expired");
      if (record.requestCount >= record.limits.maxRequests)
        failure("budget_exceeded", 429, "Session request budget is exhausted");
      if (
        record.activeCount >= record.limits.maxConcurrent ||
        this.activeRequests >= (this.options.maxConcurrent ?? 16)
      ) {
        failure("rate_limited", 429, "Gateway concurrency limit is reached");
      }
      const available =
        record.limits.maxOutputTokens - record.usedOutputTokens - record.reservedOutputTokens;
      const modelLimit = record.model.optionSpecs.maxOutputTokens.max;
      const requestLimit = Math.min(available, record.limits.maxOutputTokensPerRequest, modelLimit);
      if (
        requestLimit < 1 ||
        (decoded.maxOutputTokens !== undefined && decoded.maxOutputTokens > requestLimit)
      ) {
        failure("budget_exceeded", 429, "Session output-token budget is exhausted");
      }
      const reservation = decoded.maxOutputTokens ?? requestLimit;
      record.clientSessionId ??= decoded.clientSessionId;
      record.clientThreadId ??= decoded.clientThreadId;
      record.requestCount += 1;
      record.activeCount += 1;
      record.reservedOutputTokens += reservation;
      this.activeRequests += 1;
      return {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
        },
        body: streamGatewayModelResponse({
          record,
          request: decoded,
          reservation,
          availableAtAdmission: available,
          clientSignal: request.signal,
          now: this.now,
          authorizationExpiry: () => this.#authorizationExpiry(record),
          createResponseId: () => this.tokenPort.createResponseId(),
          onSettled: () => {
            record.activeCount -= 1;
            this.activeRequests -= 1;
          },
        }),
      };
    } catch (error) {
      if (error instanceof GatewayFailure)
        return protocol === "openai-responses"
          ? errorResponse(error.code, error.status, error.message)
          : anthropicErrorResponse(error.code, error.status, error.message);
      if (error instanceof ModelGatewayProtocolError) {
        return protocol === "openai-responses"
          ? errorResponse(error.code, 400, error.message)
          : anthropicErrorResponse(error.code, 400, error.message);
      }
      return protocol === "openai-responses"
        ? errorResponse("model_error", 500, "Gateway request could not be processed")
        : anthropicErrorResponse("model_error", 500, "Gateway request could not be processed");
    }
  }

  private authorize(
    token: string,
    protocol: ModelGatewayProtocol,
  ): GatewayGrantRecord | undefined {
    const digest = this.tokenPort.digestToken(token);
    const record = this.grants.get(digest);
    return record && record.protocol === protocol && this.#isAuthorizedAt(record, this.now())
      ? record
      : undefined;
  }

  #requireGrant(grantId: string): GatewayGrantRecord {
    const record = this.grantsById.get(grantId);
    if (!record || record.revoked.signal.aborted)
      throw new Error("Model Gateway grant is missing or revoked");
    return record;
  }

  #isAuthorizedAt(record: GatewayGrantRecord, now: number): boolean {
    return (
      record.expiresAt > now || (record.turnLease !== undefined && record.turnLease.expiresAt > now)
    );
  }

  #authorizationExpiry(record: GatewayGrantRecord): number {
    return Math.max(record.expiresAt, record.turnLease?.expiresAt ?? 0);
  }
}
