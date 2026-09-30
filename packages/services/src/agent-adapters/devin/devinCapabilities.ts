import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ExecutionTarget, HarnessCapabilities } from "@zcode/shared/agent-host";
import { DEVIN_ADAPTER_VERSION, probeDevinTarget } from "./devinExecutable.js";

const PRINT_MODE_TEXT =
  "Wave 2 text is Devin CLI print mode (-p) only; stdout is opaque assistant text and is not a tool stream.";
/** 六个 unsupported 字段共用一句，避免只点名 tools/approvals/history 时漏掉 resume/images/modelSwitch。 */
const PRINT_MODE_UNSUPPORTED =
  "Wave 2 uses Devin CLI print mode (-p) only; tools, approvals, history, resumeExecution, images, and modelSwitch are unsupported.";
const HOST_MANAGED =
  "Devin keeps models on its own account path; Host-managed Provider bindings are not used. A successful CLI probe does not enable them.";

export function devinHarnessCapabilities(): HarnessCapabilities {
  const text = {
    support: "experimental" as const,
    reason: PRINT_MODE_TEXT,
  };
  const cancel = {
    support: "experimental" as const,
    reason: "Cancel terminates the active print-mode (-p) process tree.",
  };
  const no = { support: "unsupported" as const, reason: PRINT_MODE_UNSUPPORTED };
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
