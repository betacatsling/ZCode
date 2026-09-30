import {
  capabilityReportSchema,
  workspaceSessionBindingCapabilityRequestSchema,
  workspaceSessionBindingCapabilityResultSchema,
  type WorkspaceSessionBindingCapabilityRequest,
  type WorkspaceSessionBindingCapabilityResult,
  type AgentModelFailure,
  type ExecutionTarget,
} from "@zcode/shared/agent-host";
import type { HarnessRegistry } from "./harnessRegistry.js";
import type { ModelCatalogPort, ModelCatalogSnapshotPort } from "./modelBindingPlanner.js";

export function createWorkspaceSessionCapabilityReader(input: {
  target: ExecutionTarget;
  catalog: ModelCatalogPort;
  registry: HarnessRegistry;
  hasNativeOwner: boolean;
}): (
  request: WorkspaceSessionBindingCapabilityRequest,
) => Promise<WorkspaceSessionBindingCapabilityResult> {
  return async (raw) => {
    const request = workspaceSessionBindingCapabilityRequestSchema.parse(raw);
    let credentialAttention: AgentModelFailure | undefined;
    const report = (
      support: "supported" | "unsupported" | "experimental" | "unknown",
      reason?: string,
    ) =>
      workspaceSessionBindingCapabilityResultSchema.parse({
        targetId: input.target.id,
        report: capabilityReportSchema.parse({ support, ...(reason ? { reason } : {}) }),
        ...(credentialAttention ? { credentialAttention } : {}),
      });
    if (!input.target.available) return report("unsupported", "target-unavailable");

    if (request.harnessId === "zcode") {
      if (request.modelBinding.kind !== "native-selection") {
        return report("unsupported", "model-binding-mismatch");
      }
      return input.hasNativeOwner
        ? report("supported")
        : report("unsupported", "harness-unavailable");
    }
    if (request.modelBinding.kind === "native-selection") {
      return report("unsupported", "model-binding-mismatch");
    }

    let harness: ReturnType<HarnessRegistry["require"]>;
    try {
      harness = input.registry.require(request.harnessId);
    } catch {
      return report("unsupported", "harness-unavailable");
    }

    try {
      const probe = await harness.probe(input.target);
      if (probe.support !== "supported") {
        return report(
          probe.support,
          probe.support === "experimental" ? "harness-experimental" : "harness-not-ready",
        );
      }
      if (request.modelBinding.kind === "harness-managed") {
        const support = await harness.harnessManagedSupport?.(
          input.target,
          request.modelBinding.nativeModelId,
        );
        if (support?.support !== "supported") {
          return report(
            support?.support ?? "unsupported",
            support?.support === "experimental"
              ? "model-binding-experimental"
              : "model-binding-unsupported",
          );
        }
        return report("supported");
      }

      const catalog: ModelCatalogSnapshotPort = input.catalog.capture?.() ?? input.catalog;
      const selection = request.modelBinding.selection;
      if (!catalog.validateSelection(selection).ok)
        return report("unsupported", "model-unavailable");
      // Same auto-clearing check as turn admission; informational only, open/create stay allowed.
      credentialAttention = catalog.credentialAttention?.(selection)?.failure;
      const support = await harness.hostManagedSupport(input.target, selection);
      if (support.support !== "supported") {
        return report(
          support.support,
          support.support === "experimental"
            ? "model-binding-experimental"
            : "model-binding-unsupported",
        );
      }
      if (!harness.hostManagedRoute) return report("unsupported", "model-route-unavailable");
      return report("supported");
    } catch {
      return report("unknown", "capability-query-failed");
    }
  };
}
