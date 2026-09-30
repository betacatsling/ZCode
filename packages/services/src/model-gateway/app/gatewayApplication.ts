import type {
  CreateModelGatewayOptions,
  ModelGatewayErrorBody,
  ModelGatewayErrorCode,
  ModelGatewayGrant,
  ModelGatewayGrantInput,
} from "../contract.js";
import { ModelGatewayProtocolError } from "../domain/errors.js";
import { rejectResponsesBeyondBoundModel } from "../domain/boundModelLimits.js";
import { decodeResponsesRequest } from "../domain/responsesDecoder.js";
import type {
  GatewayHttpHandler,
  GatewayHttpRequest,
  GatewayHttpResponse,
  GatewayTokenPort,
} from "./transport.js";
import { parseResponsesJson } from "./responsesHttpEncoding.js";
import { streamGatewayModelResponse } from "./modelResponseStream.js";
import {
  decodeMessagesRequest,
  parsePinnedAnthropicBetaHeader,
} from "../domain/messagesDecoder.js";
import { parseMessagesJson } from "./messagesHttpEncoding.js";
import { streamGatewayMessagesResponse } from "./messagesResponseStream.js";
import { GatewayGrantStore } from "./grantStore.js";

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
  private readonly grantStore: GatewayGrantStore;
  private activeRequests = 0;

  constructor(
    private readonly options: CreateModelGatewayOptions,
    tokenPort: GatewayTokenPort,
    now: () => number = Date.now,
  ) {
    this.grantStore = new GatewayGrantStore(options, tokenPort, now);
    this.tokenPort = tokenPort;
    this.now = now;
  }

  private readonly tokenPort: GatewayTokenPort;
  private readonly now: () => number;

  setBaseUrl(baseUrl: string): void {
    this.grantStore.setBaseUrl(baseUrl);
  }

  createGrant(input: ModelGatewayGrantInput): ModelGatewayGrant {
    return this.grantStore.createGrant(input);
  }

  renewGrant(
    grantId: string,
    input: { readonly expectedModelBindingFingerprint: string; readonly expiresInMs: number },
  ): { readonly expiresAt: number } {
    return this.grantStore.renewGrant(grantId, input);
  }

  beginTurnLease(grantId: string, turnId: string): { readonly expiresAt: number } {
    return this.grantStore.beginTurnLease(grantId, turnId);
  }

  renewTurnLease(grantId: string, turnId: string): { readonly expiresAt: number } {
    return this.grantStore.renewTurnLease(grantId, turnId);
  }

  endTurnLease(grantId: string, turnId: string): void {
    this.grantStore.endTurnLease(grantId, turnId);
  }

  revoke(grantId: string): void {
    this.grantStore.revoke(grantId);
  }

  close(): void {
    this.grantStore.close();
  }

  async handle(request: GatewayHttpRequest): Promise<GatewayHttpResponse> {
    if (this.grantStore.isClosed)
      return errorResponse("unavailable", 503, "Model Gateway is closed");
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
    if (!protocol) return errorResponse("not_found", 404, "Route is not supported");
    if (request.method !== "POST")
      return protocol === "openai-responses"
        ? errorResponse("method_not_allowed", 405, "Method is not supported")
        : anthropicErrorResponse("method_not_allowed", 405, "Method is not supported");
    let betas: ReadonlySet<string> | undefined;
    if (protocol === "anthropic-messages") {
      if (request.anthropicVersion !== "2023-06-01")
        return anthropicErrorResponse(
          "unsupported_feature",
          400,
          "Anthropic-Version is not supported",
        );
      if (request.contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
        return anthropicErrorResponse(
          "invalid_request",
          400,
          "Content-Type must be application/json",
        );
      if (request.anthropicDirectBrowserAccess !== "true")
        return anthropicErrorResponse(
          "unsupported_feature",
          400,
          "Anthropic client header is not supported",
        );
      betas = parsePinnedAnthropicBetaHeader(request.anthropicBeta);
      if (!betas)
        return anthropicErrorResponse(
          "unsupported_feature",
          400,
          "Anthropic beta header is not supported",
        );
    }
    const token =
      protocol === "openai-responses"
        ? parseBearer(request.authorization)
        : parseCapability(request.apiKey);
    const record = token ? this.grantStore.authorize(token, protocol) : undefined;
    if (!record)
      return protocol === "openai-responses"
        ? errorResponse("unauthorized", 401, "Session grant is missing, expired, or revoked")
        : anthropicErrorResponse(
            "unauthorized",
            401,
            "Session grant is missing, expired, or revoked",
          );
    try {
      if (protocol === "anthropic-messages") {
        const body = parseMessagesJson(await readBody(request, record.limits.maxBodyBytes));
        if (!betas) failure("unsupported_feature", 400, "Anthropic beta header is not supported");
        const decoded = decodeMessagesRequest(body, record.publicModelId, record.model, betas);
        if (!this.grantStore.isAuthorizedAt(record, this.now()))
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
        const requestLimit = Math.min(
          available,
          record.limits.maxOutputTokensPerRequest,
          modelLimit,
        );
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
            authorizationExpiry: () => this.grantStore.authorizationExpiry(record),
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
      rejectResponsesBeyondBoundModel({
        ...(decoded.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: decoded.maxOutputTokens }),
        contextWindow: record.model.properties.contextWindow,
        toolCount: decoded.tools.length,
        supportsToolCall: record.model.properties.supportsToolCall,
      });
      if (
        record.clientSessionId !== undefined &&
        record.clientSessionId !== decoded.clientSessionId
      ) {
        failure("unauthorized", 401, "Session grant is bound to another Codex session");
      }
      if (record.clientThreadId !== undefined && record.clientThreadId !== decoded.clientThreadId) {
        failure("unauthorized", 401, "Session grant is bound to another Codex thread");
      }
      if (!this.grantStore.isAuthorizedAt(record, this.now()))
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
          authorizationExpiry: () => this.grantStore.authorizationExpiry(record),
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
}
