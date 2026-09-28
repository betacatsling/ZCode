import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ExecutionTarget, HarnessCapabilities } from "@zcode/shared/agent-host";
import { MODEL_GATEWAY_VERSION } from "@zcode/services/model-gateway";
import { PINNED_CLAUDE_CLI_VERSION, probeClaudeTarget } from "./claudeExecutable.js";

export interface ClaudeFakeModelCompatibilityEvidence {
  readonly providerId: string;
  readonly modelId: string;
  readonly fixtureId: string;
}

const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export async function claudeHostManagedSupport(input: {
  readonly target: ExecutionTarget;
  readonly selection: ModelSelection;
  readonly executablePath?: string;
  readonly fakeModelCompatibilityEvidence?: (
    selection: ModelSelection,
  ) => ClaudeFakeModelCompatibilityEvidence | undefined;
  readonly isMessagesSelection: (selection: ModelSelection) => boolean;
}) {
  const targetReport = await probeClaudeTarget(input.target, input.executablePath);
  if (targetReport.support !== "supported") return targetReport;
  if (!input.isMessagesSelection(input.selection)) {
    return { support: "unsupported" as const, reason: "Claude Gateway requires Anthropic Messages Model bindings" };
  }
  const effort = input.selection.options?.reasoningLevel;
  if (!effort || !CLAUDE_EFFORT_LEVELS.has(effort)) {
    return { support: "unsupported" as const, reason: "Claude Code effort must match the bound Model" };
  }
  const evidence = input.fakeModelCompatibilityEvidence?.(input.selection);
  const constraints = {
    cliVersion: PINNED_CLAUDE_CLI_VERSION,
    gatewayVersion: MODEL_GATEWAY_VERSION,
    apiFormat: "anthropic-messages",
    effort,
  };
  if (
    evidence &&
    evidence.fixtureId.trim() &&
    evidence.providerId === input.selection.providerId &&
    evidence.modelId === input.selection.modelId
  ) {
    return {
      support: "supported" as const,
      reason: "This exact selection has local FakeModel control and Messages evidence only.",
      constraints: {
        ...constraints,
        compatibilityEvidence: "fake-model-fixture",
        fixtureId: evidence.fixtureId,
        fixtureProviderId: evidence.providerId,
        fixtureModelId: evidence.modelId,
      },
    };
  }
  return {
    support: "experimental" as const,
    reason: "Pinned Claude control has FakeModel evidence; this Provider/model has no live compatibility certification.",
    constraints,
  };
}

export function claudeHarnessCapabilities(): HarnessCapabilities {
  const experimental = {
    support: "experimental" as const,
    reason: "Verified through Claude Code CLI 2.1.263 and a loopback FakeModel only.",
  };
  const unsupported = {
    support: "unsupported" as const,
    reason: "This experimental Claude adapter does not certify the requested capability.",
  };
  return {
    text: experimental,
    tools: experimental,
    approvals: experimental,
    cancelTurn: experimental,
    history: experimental,
    resumeExecution: unsupported,
    images: unsupported,
    modelSwitch: unsupported,
  };
}
