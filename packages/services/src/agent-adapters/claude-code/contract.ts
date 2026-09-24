import type { BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";
import type { GatewayTokenBinding } from "../../model-gateway/contract.js";
import type { ClaudeTransportOptions } from "./claudeTransport.js";

/** Trusted target-local only: service composition supplies the actual Model Gateway (not a second executor). */
export interface ClaudeGatewayLease {
  readonly url: string;
  issueToken(binding: GatewayTokenBinding): Promise<string>;
  revokeToken(token: string): void;
}
export interface TrustedClaudeProfile {
  /** Isolated, target-owned root outside the repository and personal HOME. */
  root: string;
  /** Verifies target, generation, worktree membership, and real cwd on the execution target. */
  verifyCwd(spec: SessionSpecV2): Promise<string>;
  /** Maps frozen effective selection to a real native CLI backend model identifier; never use a token as a model ID. */
  nativeModel(spec: SessionSpecV2, plan: BindingPlan): string;
  gateway: ClaudeGatewayLease;
  /** Tests only: the actual transport remains ClaudeCodeTransport. */
  transportFactory?: (
    options: ClaudeTransportOptions,
  ) => import("./claudeTransport.js").ClaudeCodeTransport;
}
