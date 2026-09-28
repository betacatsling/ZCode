import { createModelGateway } from "./createModelGateway.js";
import type {
  ModelGateway,
  TargetModelGatewayOptions,
  TargetModelGatewayPort,
} from "./contract.js";

export const MODEL_GATEWAY_GRANT_LIFETIME_MS = 10 * 60_000;
export const MODEL_GATEWAY_TURN_LEASE_MAX_MS = 3 * 60_000;
export const MODEL_GATEWAY_TURN_LEASE_RENEW_INTERVAL_MS = 60_000;

/**
 * 一个目标 Host owner 上的一份 loopback Gateway。
 * SSH 场景里这份 owner 在远端 Core 上；隧道断开不会调用 close。
 */
export class TargetModelGateway implements TargetModelGatewayPort {
  readonly grantLifetimeMs: number;
  readonly turnLeaseMaxMs: number;
  readonly #maxConcurrent: number;
  #gateway?: ModelGateway;
  #targetId?: string;
  #closed = false;

  constructor(private readonly options: TargetModelGatewayOptions = {}) {
    this.grantLifetimeMs = options.grantLifetimeMs ?? MODEL_GATEWAY_GRANT_LIFETIME_MS;
    this.turnLeaseMaxMs = options.turnLeaseMaxMs ?? MODEL_GATEWAY_TURN_LEASE_MAX_MS;
    this.#maxConcurrent = options.maxConcurrent ?? 8;
    if (
      !Number.isSafeInteger(this.grantLifetimeMs) ||
      this.grantLifetimeMs < 1 ||
      this.grantLifetimeMs > 10 * 60_000 ||
      !Number.isSafeInteger(this.turnLeaseMaxMs) ||
      this.turnLeaseMaxMs < 1 ||
      this.turnLeaseMaxMs > 10 * 60_000 ||
      !Number.isSafeInteger(this.#maxConcurrent) ||
      this.#maxConcurrent < 1 ||
      this.#maxConcurrent > 128
    ) {
      throw new Error("Target Model Gateway limits are invalid");
    }
  }

  get(targetId: string): ModelGateway {
    if (this.#closed) throw new Error("Target Model Gateway is closed");
    if (this.#gateway && this.#targetId !== targetId)
      throw new Error("Target Model Gateway is scoped to another execution target");
    if (!this.#gateway) {
      this.#targetId = targetId;
      this.#gateway = createModelGateway({
        targetId,
        host: "127.0.0.1",
        port: 0,
        maxConcurrent: this.#maxConcurrent,
        maxGrantLifetimeMs: this.grantLifetimeMs,
        maxTurnLeaseMs: this.turnLeaseMaxMs,
        ...(this.options.now ? { now: this.options.now } : {}),
      });
    }
    return this.#gateway;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#gateway?.close();
    this.#gateway = undefined;
    this.#targetId = undefined;
  }
}
