import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ExecutionTarget, HarnessCapabilities } from "@zcode/shared/agent-host";
import { MODEL_GATEWAY_VERSION } from "@zcode/services/model-gateway";
import { reasoningIsDisabled } from "./codexBinding.js";
import { PINNED_CODEX_CLI_VERSION, readCodexCliVersion } from "./codexExecutable.js";
import { resolveCodexExecutable } from "./codexProfile.js";

export interface FakeModelCompatibilityEvidence {
  readonly providerId: string;
  readonly modelId: string;
  readonly fixtureId: string;
}

export async function probeCodexTarget(target: ExecutionTarget, executablePath?: string) {
  if (!target.available)
    return { support: "unsupported" as const, reason: target.reason ?? "target unavailable" };
  if (target.kind !== "local" || target.platform !== process.platform) {
    return {
      support: "unsupported" as const,
      reason: "Codex app-server must run on its local execution target",
    };
  }
  try {
    const executable = await resolveCodexExecutable(executablePath);
    const version = await readCodexCliVersion(executable);
    return version === PINNED_CODEX_CLI_VERSION
      ? { support: "supported" as const }
      : {
          support: "unsupported" as const,
          reason: "Codex CLI version does not match the pinned app-server contract",
        };
  } catch {
    return {
      support: "unsupported" as const,
      reason: "Pinned Codex CLI is unavailable or failed its isolated version check",
    };
  }
}

export async function codexHostManagedSupport(input: {
  target: ExecutionTarget;
  selection: ModelSelection;
  executablePath?: string;
  adapterVersion: string;
  isOpenAiResponsesSelection: (selection: ModelSelection) => boolean;
  fakeModelCompatibilityEvidence?: (
    selection: ModelSelection,
  ) => FakeModelCompatibilityEvidence | undefined;
}) {
  const report = await probeCodexTarget(input.target, input.executablePath);
  if (report.support !== "supported") return report;
  if (!input.isOpenAiResponsesSelection(input.selection)) {
    return {
      support: "unsupported" as const,
      reason: "Codex Model Gateway supports only OpenAI Responses bindings",
    };
  }
  if (!reasoningIsDisabled(input.selection.options?.reasoningLevel)) {
    return {
      support: "unsupported" as const,
      reason: "Codex Model Gateway requires reasoning to be disabled",
    };
  }
  const evidence = input.fakeModelCompatibilityEvidence?.(input.selection);
  const constraints = {
    cliVersion: input.adapterVersion,
    gatewayVersion: MODEL_GATEWAY_VERSION,
    apiFormat: "openai-responses",
  };
  if (
    evidence &&
    evidence.fixtureId.trim() &&
    evidence.providerId === input.selection.providerId &&
    evidence.modelId === input.selection.modelId
  ) {
    return {
      support: "supported" as const,
      reason:
        "This exact selection has Fake Model fixture evidence for control-path admission; no real Provider certification is implied.",
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
      "Pinned Codex control is exercised with a Fake Model, but this Provider/model selection has no exact compatibility evidence and is not admitted by SessionHost.",
    constraints,
  };
}

export function codexHarnessCapabilities(): HarnessCapabilities {
  const yes = {
    support: "experimental" as const,
    reason: "Verified only through the pinned local app-server and Fake Model control path.",
  };
  const no = {
    support: "unsupported" as const,
    reason:
      "thread/resume cold-attaches saved history only; uncertain in-flight turns are never replayed by Host resumeExecution.",
  };
  return {
    text: yes,
    tools: yes,
    approvals: yes,
    cancelTurn: yes,
    history: yes,
    resumeExecution: no,
    images: no,
    modelSwitch: no,
  };
}
