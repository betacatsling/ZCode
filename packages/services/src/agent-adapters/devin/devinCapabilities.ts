import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ExecutionTarget, HarnessCapabilities } from "@zcode/shared/agent-host";
import { DEVIN_ADAPTER_VERSION, probeDevinTarget } from "./devinExecutable.js";

const PRINT_MODE =
  "Wave 2 uses Devin CLI print mode (-p); tools/approvals/history are not parsed yet.";
const HOST_MANAGED =
  "Devin keeps models on its own account path; Host-managed Provider bindings are not used.";

export function devinHarnessCapabilities(): HarnessCapabilities {
  const text = {
    support: "experimental" as const,
    reason: PRINT_MODE,
  };
  const cancel = {
    support: "experimental" as const,
    reason: "Cancel terminates the active print-mode process tree.",
  };
  const no = { support: "unsupported" as const, reason: PRINT_MODE };
  return {
    text,
    tools: no,
    approvals: no,
    cancelTurn: cancel,
    history: no,
    resumeExecution: no,
    images: no,
    modelSwitch: no,
  };
}

export async function devinHostManagedSupport(input: {
  readonly target: ExecutionTarget;
  readonly selection: ModelSelection;
  readonly executablePath?: string;
}) {
  const report = await probeDevinTarget(input.target, input.executablePath);
  if (report.support === "unsupported") return report;
  return {
    support: "unsupported" as const,
    reason: HOST_MANAGED,
    constraints: {
      adapterVersion: DEVIN_ADAPTER_VERSION,
      requestedProviderId: input.selection.providerId,
      requestedModelId: input.selection.modelId,
    },
  };
}

export async function devinHarnessManagedSupport(input: {
  readonly target: ExecutionTarget;
  readonly executablePath?: string;
}) {
  return probeDevinTarget(input.target, input.executablePath);
}
