import { createModelGateway, TargetModelGateway } from "./index.js";
import type { Model } from "@zcode/contracts";

export async function startSessionGateway(boundModel: Model) {
  const gateway = createModelGateway({ targetId: "target-local", host: "127.0.0.1", port: 0 });
  const { baseUrl } = await gateway.start();
  const grant = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: "session-123",
    modelBindingFingerprint: "sha256:binding-plan",
    publicModelId: "zcode-bound-model",
    model: boundModel,
    expiresInMs: 60_000,
    limits: {
      maxBodyBytes: 256_000,
      maxRequests: 24,
      maxConcurrent: 2,
      maxOutputTokens: 8_000,
      maxOutputTokensPerRequest: 2_000,
    },
  });
  if (grant.baseUrl !== baseUrl) throw new Error("gateway address mismatch");
  gateway.renewGrant(grant.id, {
    expectedModelBindingFingerprint: grant.modelBindingFingerprint,
    expiresInMs: 60_000,
  });
  const lease = gateway.beginTurnLease(grant.id, "host-turn-1");
  if (lease.expiresAt <= grant.expiresAt) throw new Error("turn lease was not opened");
  gateway.renewTurnLease(grant.id, "host-turn-1");
  gateway.endTurnLease(grant.id, "host-turn-1");
  const targetOwner = new TargetModelGateway();
  const sharedTargetGateway = targetOwner.get("target-local");
  if (sharedTargetGateway === gateway) throw new Error("separate target owners must stay isolated");
  await targetOwner.close();
  return { gateway, grant, targetOwner };
}
