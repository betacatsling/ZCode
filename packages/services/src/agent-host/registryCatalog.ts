import { ProviderRegistry, type ProviderRegistryService } from "@zcode/provider";
import type { ModelCatalogPort } from "./modelBindingPlanner.js";

/** Adapter uses the same live Registry validation as the native CLI, not model-name guesses. */
export function createRegistryModelCatalog(registry: ProviderRegistryService): ModelCatalogPort {
  const snapshot = registry.getSnapshot();
  if (!snapshot) throw new Error("Provider Registry not started");
  const frozen = new ProviderRegistry(snapshot.registry.providers);
  return {
    fingerprint: JSON.stringify(snapshot.sourceRevisions),
    validateSelection(selection) {
      const result = frozen.validateSelection(selection);
      return result.ok ? { ok: true } : { ok: false, reason: result.code };
    },
  };
}
