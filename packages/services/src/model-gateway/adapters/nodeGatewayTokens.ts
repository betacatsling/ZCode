import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { GatewayTokenPort } from "../app/transport.js";

export const nodeGatewayTokens: GatewayTokenPort = {
  createOpaqueToken: () => randomBytes(32).toString("base64url"),
  digestToken: (token) => createHash("sha256").update(token).digest("hex"),
  createResponseId: () => "resp_" + randomUUID().replaceAll("-", ""),
};
