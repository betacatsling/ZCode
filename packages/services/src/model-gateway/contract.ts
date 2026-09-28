import type { BindingPlan } from "@zcode/shared/agent-host";
import type { Model } from "@zcode/contracts";
import { z } from "zod";

export const MODEL_GATEWAY_VERSION = "0.3.0";
export const modelGatewayProtocolSchema = z.enum(["openai-responses", "anthropic-messages"]);
export type ModelGatewayProtocol = z.infer<typeof modelGatewayProtocolSchema>;

export const modelGatewayLimitsSchema = z
  .strictObject({
    maxBodyBytes: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
    maxRequests: z.number().int().min(1).max(100_000),
    maxConcurrent: z.number().int().min(1).max(128),
    maxOutputTokens: z.number().int().min(1).max(1_000_000),
    maxOutputTokensPerRequest: z.number().int().min(1).max(1_000_000),
  })
  .refine((limits) => limits.maxOutputTokensPerRequest <= limits.maxOutputTokens, {
    message: "per-request output budget must not exceed the grant output budget",
  });
export type ModelGatewayLimits = z.infer<typeof modelGatewayLimitsSchema>;

export interface ModelGatewayGrantInput {
  readonly protocol: ModelGatewayProtocol;
  readonly sessionId: string;
  readonly modelBindingFingerprint: string;
  readonly publicModelId: string;
  readonly model: Model;
  /** Host-owned admission plan. Request bodies cannot replace its route or model. */
  readonly plan?: BindingPlan;
  readonly expiresInMs: number;
  readonly limits: ModelGatewayLimits;
}

export interface ModelGatewayGrant {
  readonly id: string;
  readonly token: string;
  readonly baseUrl: string;
  readonly protocol: ModelGatewayProtocol;
  readonly sessionId: string;
  readonly modelBindingFingerprint: string;
  readonly actualModel: {
    readonly providerId: Model["providerId"];
    readonly modelId: Model["modelId"];
  };
  readonly publicModelId: string;
  readonly expiresAt: number;
}

export interface ModelGatewayListenAddress {
  readonly baseUrl: string;
}

export interface ModelGateway {
  start(): Promise<ModelGatewayListenAddress>;
  createGrant(input: ModelGatewayGrantInput): ModelGatewayGrant;
  renewGrant(
    grantId: string,
    input: { readonly expectedModelBindingFingerprint: string; readonly expiresInMs: number },
  ): { readonly expiresAt: number };
  beginTurnLease(grantId: string, turnId: string): { readonly expiresAt: number };
  renewTurnLease(grantId: string, turnId: string): { readonly expiresAt: number };
  endTurnLease(grantId: string, turnId: string): void;
  revoke(grantId: string): void;
  close(): Promise<void>;
}

/** Target-local owner that shares one loopback Gateway across Harness adapters. */
export interface TargetModelGatewayPort {
  readonly grantLifetimeMs: number;
  readonly turnLeaseMaxMs: number;
  get(targetId: string): ModelGateway;
  close(): Promise<void>;
}

export interface TargetModelGatewayOptions {
  readonly now?: () => number;
  readonly grantLifetimeMs?: number;
  readonly turnLeaseMaxMs?: number;
  readonly maxConcurrent?: number;
}

export interface CreateModelGatewayOptions {
  readonly targetId: string;
  readonly host: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly maxConcurrent?: number;
  readonly maxGrantLifetimeMs?: number;
  readonly maxTurnLeaseMs?: number;
  /** Injectable target-local clock for deterministic expiry and lease tests. */
  readonly now?: () => number;
}

export type ModelGatewayErrorCode =
  | "invalid_request"
  | "unsupported_feature"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "budget_exceeded"
  | "rate_limited"
  | "unavailable"
  | "model_error";

export interface ModelGatewayErrorBody {
  readonly error: {
    readonly type: "invalid_request_error" | "authentication_error" | "server_error";
    readonly code: ModelGatewayErrorCode;
    readonly message: string;
  };
}
