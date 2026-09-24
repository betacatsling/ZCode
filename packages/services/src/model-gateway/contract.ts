import type { Model, ModelEvent, ModelRequest } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";

export type GatewayProtocolId = "responses" | "anthropic-messages";
export interface DecodedGatewayRequest {
  request: ModelRequest;
  modelId: string;
  stream: true;
}
export interface GatewayStreamContext {
  requestId: string;
  modelId: string;
  createdAt: number;
  signal?: AbortSignal;
}
export interface GatewaySseFrame {
  event?: string;
  data: unknown;
}
export interface GatewayProtocolAdapter {
  id: GatewayProtocolId;
  paths: readonly string[];
  allowedQueryParameters?: Readonly<Record<string, readonly string[]>>;
  decode(
    body: unknown,
    headers: Readonly<Record<string, string | undefined>>,
  ): DecodedGatewayRequest;
  encode(
    events: AsyncIterable<ModelEvent>,
    context: GatewayStreamContext,
  ): AsyncIterable<GatewaySseFrame>;
}
export interface GatewayTokenBinding {
  targetId: string;
  hostSessionId: string;
  runtimeEpoch: string;
  turnId: string;
  protocol: GatewayProtocolId;
  requestedModelAlias: string;
  effectiveSelection: ModelSelection;
  expiresAt: number;
  maxRequests: number;
  maxOutputBytes: number;
  maxGenerationTokens: number;
  maxOutputTokensPerRequest: number;
}
export interface GatewayLimits {
  maxBodyBytes: number;
  maxConcurrentRequests: number;
}
export type GatewayObservation = (event: { code: string; protocol?: GatewayProtocolId }) => void;
export interface ModelGatewayOptions {
  protocols: readonly GatewayProtocolAdapter[];
  resolveModel(binding: Readonly<GatewayTokenBinding>): Model | Promise<Model>;
  limits: GatewayLimits;
  observe?: GatewayObservation;
}
export interface ModelGateway {
  start(): Promise<{ url: string; port: number }>;
  issueToken(binding: GatewayTokenBinding): Promise<string>;
  revokeToken(token: string): void;
  close(): Promise<void>;
}
