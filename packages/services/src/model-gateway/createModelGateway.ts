import type {
  CreateModelGatewayOptions,
  ModelGateway,
  ModelGatewayGrant,
  ModelGatewayGrantInput,
} from "./contract.js";
import { GatewayApplication } from "./app/gatewayApplication.js";
import { nodeGatewayTokens } from "./adapters/nodeGatewayTokens.js";
import { createNodeGatewayHttpServer } from "./adapters/nodeGatewayHttpServer.js";

function validateOptions(options: CreateModelGatewayOptions): void {
  if (!options.targetId.trim() || options.targetId.length > 256)
    throw new Error("targetId must be a bounded non-empty string");
  if (!(options.host === "127.0.0.1" || options.host === "::1"))
    throw new Error("Model Gateway may bind only to loopback");
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)
  ) {
    throw new Error("Model Gateway port is invalid");
  }
  if (
    options.maxConcurrent !== undefined &&
    (!Number.isInteger(options.maxConcurrent) ||
      options.maxConcurrent < 1 ||
      options.maxConcurrent > 128)
  ) {
    throw new Error("Model Gateway concurrency limit is invalid");
  }
  if (
    options.maxGrantLifetimeMs !== undefined &&
    (!Number.isInteger(options.maxGrantLifetimeMs) ||
      options.maxGrantLifetimeMs < 1 ||
      options.maxGrantLifetimeMs > 10 * 60_000)
  ) {
    throw new Error("Model Gateway grant lifetime must not exceed ten minutes");
  }
  if (
    options.maxTurnLeaseMs !== undefined &&
    (!Number.isInteger(options.maxTurnLeaseMs) ||
      options.maxTurnLeaseMs < 1 ||
      options.maxTurnLeaseMs > 10 * 60_000)
  ) {
    throw new Error("Model Gateway turn lease must not exceed ten minutes");
  }
}

export function createModelGateway(options: CreateModelGatewayOptions): ModelGateway {
  validateOptions(options);
  const http = createNodeGatewayHttpServer();
  const application = new GatewayApplication(options, nodeGatewayTokens, options.now);
  let address: { readonly baseUrl: string } | undefined;
  let closed = false;
  return {
    async start() {
      if (closed) throw new Error("Model Gateway is closed");
      if (address) return address;
      address = await http.listen({
        host: options.host,
        port: options.port ?? 0,
        handler: application,
      });
      application.setBaseUrl(address.baseUrl);
      return address;
    },
    createGrant(input: ModelGatewayGrantInput): ModelGatewayGrant {
      return application.createGrant(input);
    },
    renewGrant(grantId, input) {
      return application.renewGrant(grantId, input);
    },
    beginTurnLease(grantId, turnId) {
      return application.beginTurnLease(grantId, turnId);
    },
    renewTurnLease(grantId, turnId) {
      return application.renewTurnLease(grantId, turnId);
    },
    endTurnLease(grantId, turnId) {
      application.endTurnLease(grantId, turnId);
    },
    revoke(grantId: string): void {
      application.revoke(grantId);
    },
    async close() {
      if (closed) return;
      closed = true;
      application.close();
      await http.close();
    },
  };
}
