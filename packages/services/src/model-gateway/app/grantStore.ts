import type {
  CreateModelGatewayOptions,
  ModelGatewayGrant,
  ModelGatewayGrantInput,
  ModelGatewayProtocol,
} from "../contract.js";
import { modelGatewayLimitsSchema, modelGatewayProtocolSchema } from "../contract.js";
import { admitHostManagedGrant } from "../domain/bindingAdmission.js";
import type { GatewayGrantRecord } from "./modelResponseStream.js";
import type { GatewayTokenPort } from "./transport.js";

export class GatewayGrantStore {
  private readonly grants = new Map<string, GatewayGrantRecord>();
  private readonly grantsById = new Map<string, GatewayGrantRecord>();
  private readonly sessions = new Map<string, string>();
  private closed = false;
  private baseUrl: string | undefined;

  constructor(
    private readonly options: CreateModelGatewayOptions,
    private readonly tokenPort: GatewayTokenPort,
    private readonly now: () => number = Date.now,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  createGrant(input: ModelGatewayGrantInput): ModelGatewayGrant {
    if (this.closed || !this.baseUrl)
      throw new Error("Model Gateway must be started before grants are issued");
    const limits = modelGatewayLimitsSchema.parse(input.limits);
    if (!input.modelBindingFingerprint.trim() || input.modelBindingFingerprint.length > 512) {
      throw new Error("modelBindingFingerprint must be a bounded non-empty string");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.publicModelId))
      throw new Error("publicModelId is invalid");
    if (!input.model.providerId || !input.model.modelId)
      throw new Error("bound Model must expose its actual Provider and model identity");
    // 路由、会话和生效模型只接受宿主 BindingPlan，不从请求体猜测，也不保存 credentialRef。
    admitHostManagedGrant({
      protocol: input.protocol,
      sessionId: input.sessionId,
      modelBindingFingerprint: input.modelBindingFingerprint,
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      ...(input.model.options.reasoningLevel === undefined
        ? {}
        : { reasoningLevel: input.model.options.reasoningLevel }),
      ...(input.plan ? { plan: input.plan } : {}),
    });
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
    const record = this.requireGrant(grantId);
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
    const record = this.requireGrant(grantId);
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
    const record = this.requireGrant(grantId);
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

  authorize(
    token: string,
    protocol: ModelGatewayProtocol,
  ): GatewayGrantRecord | undefined {
    const digest = this.tokenPort.digestToken(token);
    const record = this.grants.get(digest);
    return record && record.protocol === protocol && this.isAuthorizedAt(record, this.now())
      ? record
      : undefined;
  }

  requireGrant(grantId: string): GatewayGrantRecord {
    const record = this.grantsById.get(grantId);
    if (!record || record.revoked.signal.aborted)
      throw new Error("Model Gateway grant is missing or revoked");
    return record;
  }

  isAuthorizedAt(record: GatewayGrantRecord, now: number): boolean {
    return (
      record.expiresAt > now || (record.turnLease !== undefined && record.turnLease.expiresAt > now)
    );
  }

  authorizationExpiry(record: GatewayGrantRecord): number {
    return Math.max(record.expiresAt, record.turnLease?.expiresAt ?? 0);
  }
}
