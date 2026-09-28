import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistryService } from "@zcode/provider";
import { bindHostModel } from "../../agent-host/modelBinding.js";
import { PiHarnessAdapter } from "./piHarnessAdapter.js";

/** Production wiring: every Pi model request uses the same Registry + CLI Model adapter as native ZCode. */
export function createRegistryPiHarness(options: {
  root: string;
  registry: ProviderRegistryService;
  adapter?: AiSdkModelAdapter;
}): PiHarnessAdapter {
  const adapter = options.adapter ?? new AiSdkModelAdapter({});
  return new PiHarnessAdapter({
    root: options.root,
    modelFactory: (_spec, plan) => bindHostModel({ plan, registry: options.registry, adapter }),
  });
}
