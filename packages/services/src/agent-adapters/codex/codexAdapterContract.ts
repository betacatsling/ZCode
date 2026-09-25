import type { ModelGateway } from "../../model-gateway/contract.js";
import type { BindingPlan } from "@zcode/shared/agent-host";

/** Target-local authority: capture the exact frozen Model before issuing a single-turn token. */
export interface CodexTurnLeaseIssuer {
  gateway: Pick<ModelGateway, "issueToken" | "revokeToken">;
  gatewayUrl: string;
  /** Never reuse an alias across turn scopes. Reject unsupported bindings before issuing. */
  issue(input: {
    plan: BindingPlan;
    hostSessionId: string;
    runtimeEpoch: string;
    turnId: string;
  }): Promise<{ token: string; modelAlias: string }>;
}

export const codexTrustedManifest = {
  schemaVersion: 1,
  id: "codex",
  name: "Codex",
  adapterVersion: "0.156.1",
} as const;

/** V2 create/attach are the only writable Codex session contract; legacy V1 is Host history-only. */
