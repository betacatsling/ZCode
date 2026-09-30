import type { AgentErrorCode, SessionSpec } from "@zcode/shared/agent-host";
import type { ModelCatalogSnapshotPort } from "./modelBindingPlanner.js";

/**
 * The session's own host-managed Provider/model is gone from the catalog (removed Provider,
 * deleted model, ...). The user must reconfigure; nothing is replanned onto another model.
 * `code` matches the send receipt's reasonCode; `message` stays the Registry code.
 */
export class ModelBindingReconfigureRequiredError extends Error {
  readonly code: Extract<AgentErrorCode, "invalid-binding"> = "invalid-binding";
  readonly action = "reconfigure-provider" as const;

  constructor(
    readonly reason: string,
    readonly providerId: string,
    readonly modelId: string,
  ) {
    super(reason);
    this.name = "ModelBindingReconfigureRequiredError";
  }
}

/** Returns the typed error when the session's own selection fails catalog validation. */
export function staleModelBindingError(
  spec: SessionSpec,
  catalog: Pick<ModelCatalogSnapshotPort, "validateSelection">,
): ModelBindingReconfigureRequiredError | undefined {
  if (spec.modelBinding.kind !== "host-managed") return undefined;
  const { selection } = spec.modelBinding;
  const result = catalog.validateSelection(selection);
  return result.ok
    ? undefined
    : new ModelBindingReconfigureRequiredError(
        result.reason,
        selection.providerId,
        selection.modelId,
      );
}
