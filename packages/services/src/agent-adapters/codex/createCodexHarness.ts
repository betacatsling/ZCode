import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { bindHostModel } from "../../agent-host/modelBinding.js";
import type { CodexAppServerLauncher } from "./codexAppServerProcess.js";
import { CodexHarnessAdapter } from "./codexHarnessAdapter.js";
import type { FakeModelCompatibilityEvidence } from "./codexCapabilities.js";
import type { TargetModelGatewayPort } from "@zcode/services/model-gateway";

/** Explicit opt-in factory. The default composition does not register Codex automatically. */
export function createExperimentalRegistryCodexHarness(options: {
  root: string;
  registry: ProviderRegistryService;
  executablePath?: string;
  targetModelGateway?: TargetModelGatewayPort;
  adapter?: AiSdkModelAdapter;
  /** Explicit evidence hook for one deterministic Fake Model fixture; production callers omit it. */
  fakeModelCompatibilityEvidence?: (
    selection: ModelSelection,
  ) => FakeModelCompatibilityEvidence | undefined;
  launchAppServer?: CodexAppServerLauncher;
}): CodexHarnessAdapter {
  const adapter = options.adapter ?? new AiSdkModelAdapter({});
  return new CodexHarnessAdapter({
    root: options.root,
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(options.targetModelGateway
      ? { targetModelGateway: options.targetModelGateway }
      : {}),
    ...(options.launchAppServer ? { launchAppServer: options.launchAppServer } : {}),
    isOpenAiResponsesSelection: (selection) =>
      options.registry.getProvider(selection.providerId)?.config.api.type === "openai-responses",
    ...(options.fakeModelCompatibilityEvidence
      ? { fakeModelCompatibilityEvidence: options.fakeModelCompatibilityEvidence }
      : {}),
    isSelectionAuthorized: (plan) =>
      plan.effective !== undefined && options.registry.validateSelection(plan.effective).ok,
    modelFactory: (_spec, plan) => bindHostModel({ plan, registry: options.registry, adapter }),
  });
}
