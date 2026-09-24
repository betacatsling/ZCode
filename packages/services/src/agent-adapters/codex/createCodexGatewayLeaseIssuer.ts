import { randomUUID } from "node:crypto";
import type { ModelGateway } from "../../model-gateway/contract.js";
import type { CodexTurnLeaseIssuer } from "./codexAdapterContract.js";

/** Gateway resolves/captures the Model at issueToken time, never on a later HTTP request. */
export function createCodexGatewayLeaseIssuer(input: {
  gateway: ModelGateway;
  gatewayUrl: string;
}): CodexTurnLeaseIssuer {
  return {
    gateway: input.gateway,
    gatewayUrl: input.gatewayUrl,
    async issue({ plan, hostSessionId, runtimeEpoch, turnId }) {
      if (
        plan.hostSessionId !== hostSessionId ||
        plan.route !== "responses-gateway" ||
        plan.support.support !== "supported" ||
        plan.requested.kind !== "host-managed" ||
        !plan.effective ||
        plan.effective.options?.reasoningLevel !== "off" ||
        JSON.stringify(plan.effective) !== JSON.stringify(plan.requested.selection)
      )
        throw new Error("Codex lease requires the exact certified off-only binding");
      const modelAlias = `zcode-turn-${randomUUID()}`;
      const token = await input.gateway.issueToken({
        targetId: plan.targetId,
        hostSessionId,
        runtimeEpoch,
        turnId,
        protocol: "responses",
        requestedModelAlias: modelAlias,
        effectiveSelection: plan.effective,
        expiresAt: Date.now() + 5 * 60_000,
        maxRequests: 16,
        maxOutputBytes: 4 * 1024 * 1024,
        maxGenerationTokens: 16 * 2048,
        maxOutputTokensPerRequest: 2048,
      });
      return { token, modelAlias };
    },
  };
}
