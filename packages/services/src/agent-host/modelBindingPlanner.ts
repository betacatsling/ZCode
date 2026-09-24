import { bindingPlanSchema, type BindingPlan, type ExecutionTarget, type SessionSpec } from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { HarnessAdapter } from "./harnessRegistry.js";

export interface ModelCatalogPort {
  readonly fingerprint: string;
  validateSelection(selection: ModelSelection): { ok: true } | { ok: false; reason: string };
}

/** Pure admission decision except adapter capability probes; never substitutes a default model. */
export async function planModelBinding(input: {
  spec: SessionSpec;
  target: ExecutionTarget;
  harness: HarnessAdapter;
  catalog: ModelCatalogPort;
}): Promise<BindingPlan> {
  const { spec, target, harness, catalog } = input;
  const common = {
    schemaVersion: 1 as const,
    hostSessionId: spec.hostSessionId,
    targetId: target.id,
    harnessId: spec.harness.id,
    adapterVersion: harness.version,
    catalogFingerprint: catalog.fingerprint,
    requested: spec.modelBinding,
  };
  const reject = (reason: string): BindingPlan => bindingPlanSchema.parse({
    ...common,
    support: { support: "unsupported", reason },
    capabilities: {},
  });
  if (target.id !== spec.execution.targetId || !target.available) {
    return reject(target.reason ?? "target-unavailable or target identity mismatch");
  }
  if (harness.id !== spec.harness.id || harness.version !== spec.harness.adapterVersion) {
    return reject("harness identity or adapter version mismatch");
  }
  const probe = await harness.probe(target);
  if (probe.support !== "supported") return reject(probe.reason ?? "harness not ready");
  const capabilities = await harness.capabilities(target);
  if (spec.modelBinding.kind === "harness-managed") {
    const support = await harness.harnessManagedSupport?.(target, spec.modelBinding.nativeModelId);
    if (support?.support !== "supported") {
      return reject(support?.reason ?? "harness native-account route is not certified");
    }
    return bindingPlanSchema.parse({
      ...common, route: "harness-managed", support, capabilities,
    });
  }
  const selection = spec.modelBinding.selection;
  const result = catalog.validateSelection(selection);
  if (!result.ok) return reject(result.reason);
  const support = await harness.hostManagedSupport(target, selection);
  if (support.support !== "supported" || !harness.hostManagedRoute) {
    return reject(support.reason ?? "host-managed route is not certified");
  }
  return bindingPlanSchema.parse({
    ...common,
    route: harness.hostManagedRoute,
    effective: selection,
    support,
    capabilities,
  });
}
