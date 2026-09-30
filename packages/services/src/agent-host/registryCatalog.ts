import { ProviderRegistry, type ProviderRegistryService } from "@zcode/provider";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import { bindHostModel } from "./modelBinding.js";
import type { ModelCatalogPort, ModelCatalogSnapshotPort } from "./modelBindingPlanner.js";
import {
  ProviderCredentialAttention,
  providerCredentialFingerprint,
} from "./providerCredentialAttention.js";

/** Each capture pins validation and Model creation to the same registry revisions. */
export function createRegistryModelCatalog(
  registry: ProviderRegistryService,
  adapter?: AiSdkModelAdapter,
  // Host-level "credential needs attention" state, shared by every session of this Host.
  attention: ProviderCredentialAttention = new ProviderCredentialAttention(),
): ModelCatalogPort {
  const capture = (): ModelCatalogSnapshotPort => {
    const snapshot = registry.getSnapshot();
    if (!snapshot) throw new Error("Provider Registry not started");
    const frozen = new ProviderRegistry(snapshot.registry.providers);
    const fingerprint = JSON.stringify(snapshot.sourceRevisions);
    const credentialOf = (providerId: string) => {
      const provider = frozen.getProvider(providerId);
      return provider
        ? providerCredentialFingerprint(provider.config, snapshot.sourceRevisions.account)
        : undefined;
    };
    const pinnedRegistry = {
      getSnapshot: () => snapshot,
      validateSelection: (selection: Parameters<typeof frozen.validateSelection>[0]) =>
        frozen.validateSelection(selection),
      getProvider: (providerId: Parameters<typeof frozen.getProvider>[0]) =>
        frozen.getProvider(providerId),
      getModel: (
        providerId: Parameters<typeof frozen.getModel>[0],
        modelId: Parameters<typeof frozen.getModel>[1],
      ) => frozen.getModel(providerId, modelId),
    };
    return {
      fingerprint,
      validateSelection(selection) {
        const result = frozen.validateSelection(selection);
        return result.ok ? { ok: true } : { ok: false, reason: result.code };
      },
      ...(adapter
        ? {
            bindModel(plan) {
              const model = bindHostModel({
                plan,
                registry: pinnedRegistry,
                adapter,
              });
              const credential = credentialOf(model.providerId);
              return credential ? attention.observe(model, credential) : model;
            },
          }
        : {}),
      isCurrent() {
        const current = registry.getSnapshot();
        return current !== null && JSON.stringify(current.sourceRevisions) === fingerprint;
      },
      credentialAttention(selection) {
        return attention.check(
          selection.providerId,
          selection.modelId,
          credentialOf(selection.providerId),
        );
      },
      credentialSource(selection) {
        const access = frozen.getProvider(selection.providerId)?.config.access;
        if (!access) return undefined;
        return access.type === "zhipu-account" ? "provider-account" : "provider-api-key";
      },
    };
  };
  return {
    get fingerprint() {
      return capture().fingerprint;
    },
    validateSelection(selection) {
      return capture().validateSelection(selection);
    },
    capture,
  };
}
