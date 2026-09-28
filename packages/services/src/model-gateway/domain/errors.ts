import type { ModelGatewayErrorCode } from "../contract.js";

export class ModelGatewayProtocolError extends Error {
  constructor(
    readonly code: Extract<ModelGatewayErrorCode, "invalid_request" | "unsupported_feature">,
    message: string,
  ) {
    super(message);
    this.name = "ModelGatewayProtocolError";
  }
}

export function invalidRequest(message: string): never {
  throw new ModelGatewayProtocolError("invalid_request", message);
}

export function unsupportedFeature(message: string): never {
  throw new ModelGatewayProtocolError("unsupported_feature", message);
}
