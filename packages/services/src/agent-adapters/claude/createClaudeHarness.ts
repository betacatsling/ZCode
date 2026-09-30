import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { TargetModelGateway } from "@zcode/services/model-gateway";
import { bindHostModel } from "../../agent-host/modelBinding.js";
import { ClaudeHarnessAdapter } from "./claudeHarnessAdapter.js";
import type { ClaudeFakeModelCompatibilityEvidence } from "./claudeCapabilities.js";
import type { ClaudeStreamProcess } from "./claudeStreamProcess.js";
import type { ClaudeHarnessAdapterOptions } from "./claudeHarnessAdapter.js";

/** Explicit opt-in factory; the default composition does not register Claude Code. */
export function createExperimentalRegistryClaudeHarness(options: {
  root: string;
  registry: ProviderRegistryService;
  executablePath?: string;
  adapter?: AiSdkModelAdapter;
  targetModelGateway?: TargetModelGateway;
  turnLeaseRenewIntervalMs?: number;
  onProcess?: (hostSessionId: string, process: ClaudeStreamProcess) => void;
  /** Test hook: an injected launcher owns the process (no executable discovery). */
  launchProcess?: ClaudeHarnessAdapterOptions["launchProcess"];
  /** Exact test fixture evidence only; production callers omit it. */
  fakeModelCompatibilityEvidence?: (
    selection: ModelSelection,
  ) => ClaudeFakeModelCompatibilityEvidence | undefined;
}): ClaudeHarnessAdapter {
  const adapter = options.adapter ?? new AiSdkModelAdapter({});
  return new ClaudeHarnessAdapter({
    root: options.root,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.targetModelGateway ? { targetModelGateway: options.targetModelGateway } : {}),
    ...(options.turnLeaseRenewIntervalMs
      ? { turnLeaseRenewIntervalMs: options.turnLeaseRenewIntervalMs }
      : {}),
    ...(options.onProcess ? { onProcess: options.onProcess } : {}),
    ...(options.launchProcess ? { launchProcess: options.launchProcess } : {}),
    isMessagesSelection: (selection) =>
      options.registry.getProvider(selection.providerId)?.config.api.type === "anthropic-messages",
    ...(options.fakeModelCompatibilityEvidence
      ? { fakeModelCompatibilityEvidence: options.fakeModelCompatibilityEvidence }
      : {}),
    isSelectionAuthorized: (plan) =>
      plan.effective !== undefined && options.registry.validateSelection(plan.effective).ok,
    modelFactory: (_spec, plan) => bindHostModel({ plan, registry: options.registry, adapter }),
  });
}
