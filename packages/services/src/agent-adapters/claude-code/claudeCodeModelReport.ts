import type { CapabilityReport, ModelBindingRequest } from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { redactClaudeCodeText } from "./claudeCodeNative.js";

/** Only this witness means an existing model execution layer handled the call. */
export type ClaudeCodeModelEvidence =
  | { readonly kind: "port-mock" }
  | { readonly kind: "acp-session" }
  | { readonly kind: "model-execution-layer"; readonly executionRef: string };

export interface ClaudeCodeModelBindingQuery {
  readonly scope: "selection-probe" | "session";
  readonly hostSessionId?: string;
  readonly workspaceIdentity?: string;
  readonly requested: ModelBindingRequest;
  readonly acpSessionOpen: boolean;
  readonly transportKind: "fake" | "acp";
}

export interface ClaudeCodeModelBindingInspection {
  readonly evidence: ClaudeCodeModelEvidence;
  readonly reachedModelExecutionLayer: boolean;
  readonly effectiveProviderId?: string;
  readonly effectiveModelId?: string;
  readonly reason: string;
}

export interface ClaudeCodeModelBindingPort {
  inspect(query: ClaudeCodeModelBindingQuery): Promise<ClaudeCodeModelBindingInspection>;
}

export interface ClaudeCodeModelChainReport {
  readonly plane: "model";
  readonly route: "harness-managed" | "messages-gateway";
  readonly label: "experimental" | "harness-managed" | "execution-layer";
  readonly reachedModelExecutionLayer: boolean;
  readonly acpProvesHostModel: false;
  readonly support: CapabilityReport;
}

export function createMockClaudeCodeModelBindingPort(): ClaudeCodeModelBindingPort {
  return {
    async inspect(query) {
      if (query.acpSessionOpen || query.transportKind === "acp") {
        return {
          evidence: { kind: "acp-session" },
          reachedModelExecutionLayer: false,
          reason: "ACP transport is connected; mock port did not call the model execution layer",
        };
      }
      return {
        evidence: { kind: "port-mock" },
        reachedModelExecutionLayer: false,
        reason: "Mock port did not call the model execution layer",
      };
    },
  };
}

function experimental(reason: string, acpSessionOpen: boolean): ClaudeCodeModelChainReport {
  return {
    plane: "model",
    route: "harness-managed",
    label: "experimental",
    reachedModelExecutionLayer: false,
    acpProvesHostModel: false,
    support: {
      support: "experimental",
      reason,
      constraints: {
        route: "harness-managed",
        reachedModelExecutionLayer: false,
        acpSessionOpen,
        acpProvesHostModel: false,
      },
    },
  };
}

/**
 * ACP connectivity and a mock port are not host-model acceptance.
 * A mismatched effective model is rejected instead of rewritten.
 */
export function reportClaudeCodeModelChain(input: {
  readonly requested: ModelBindingRequest;
  readonly inspection: ClaudeCodeModelBindingInspection;
  readonly acpSessionOpen: boolean;
  readonly secrets?: readonly string[];
}): ClaudeCodeModelChainReport {
  const reason = redactClaudeCodeText(input.inspection.reason, input.secrets ?? []);
  const selection: ModelSelection | undefined =
    input.requested.kind === "host-managed" ? input.requested.selection : undefined;
  if (
    selection &&
    input.inspection.effectiveProviderId &&
    input.inspection.effectiveModelId &&
    (input.inspection.effectiveProviderId !== selection.providerId ||
      input.inspection.effectiveModelId !== selection.modelId)
  ) {
    return {
      plane: "model",
      route: "harness-managed",
      label: "harness-managed",
      reachedModelExecutionLayer: false,
      acpProvesHostModel: false,
      support: {
        support: "unsupported",
        reason: "Effective model does not match the requested selection; refusing to downgrade",
        constraints: {
          route: "harness-managed",
          requestedProviderId: selection.providerId,
          requestedModelId: selection.modelId,
        },
      },
    };
  }
  if (
    (input.inspection.evidence.kind === "acp-session" || input.acpSessionOpen) &&
    input.inspection.evidence.kind !== "model-execution-layer"
  ) {
    return experimental(
      `An ACP session does not prove this harness accepts the host model. ${reason}`.trim(),
      true,
    );
  }
  const executionHit =
    input.inspection.evidence.kind === "model-execution-layer" &&
    input.inspection.reachedModelExecutionLayer &&
    input.inspection.evidence.executionRef.trim().length > 0;
  if (!executionHit) {
    return experimental(
      input.acpSessionOpen
        ? `An ACP session does not prove this harness accepts the host model. ${reason}`.trim()
        : reason || "Injected model port did not reach the existing model execution layer",
      input.acpSessionOpen,
    );
  }
  return {
    plane: "model",
    route: "messages-gateway",
    label: "execution-layer",
    reachedModelExecutionLayer: true,
    acpProvesHostModel: false,
    support: {
      support: "supported",
      constraints: {
        route: "messages-gateway",
        reachedModelExecutionLayer: true,
        acpProvesHostModel: false,
        executionRef: input.inspection.evidence.executionRef,
      },
    },
  };
}
