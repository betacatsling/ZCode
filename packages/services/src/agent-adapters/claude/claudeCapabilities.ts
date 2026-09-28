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
    return {
      support: "unsupported" as const,
      reason: "Claude Gateway requires Anthropic Messages Model bindings",
    };
  }
  const effort = input.selection.options?.reasoningLevel;
  if (!effort || !CLAUDE_EFFORT_LEVELS.has(effort)) {
    return {
      support: "unsupported" as const,
      reason: "Claude Code effort must match the bound Model",
    };
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
    reason:
      "Pinned Claude control has FakeModel evidence; this Provider/model has no live compatibility certification.",
    constraints,
  };
}

const PINNED_FAKE_MODEL_ONLY =
  "Verified only through the pinned Claude Code CLI 2.1.263 and a loopback FakeModel.";

/**
 * 唯一能力声明所有者。probe / hostManagedSupport 的 supported 不能升级这些字段。
 * 可选键 detach、terminateSession、viewHistory、hostManagedModel 故意省略：省略不是 supported。
 */
export function claudeHarnessCapabilities(): HarnessCapabilities {
  const experimental = {
    support: "experimental" as const,
    reason: PINNED_FAKE_MODEL_ONLY,
  };
  return {
    text: experimental,
    tools: experimental,
    approvals: experimental,
    cancelTurn: experimental,
    history: experimental,
    resumeExecution: {
      support: "unsupported",
      reason:
        "Cold attach and the opaque native session_id resume saved history only; uncertain in-flight turns are never replayed by Host resumeExecution.",
    },
    images: {
      support: "unsupported",
      reason: "Claude structured send accepts text only; the images surface is unsupported.",
    },
    modelSwitch: {
      support: "unsupported",
      reason: "In-turn modelSwitch is unsupported; model binding is fixed at session admission.",
    },
  };
}
