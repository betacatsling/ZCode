import type { SessionSpec } from "@zcode/shared/agent-host";
import type {
  PiModelBindingPlannerPort,
  PiModelHint,
  PiModelRouteRecord,
  PiPlannerBinding,
  PiPlannerCatalog,
  PiPlannerHarness,
  PiTurnBindContext,
} from "./piControlProtocol.js";

export type {
  PiModelBindingPlannerPort,
  PiModelHint,
  PiModelRouteRecord,
  PiPlannerBinding,
} from "./piControlProtocol.js";

const SECRET_TEXT = /sk-|bearer\s+|https?:\/\//i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

export interface PiRouteDecision {
  readonly record: PiModelRouteRecord;
  readonly hint?: PiModelHint;
}

/**
 * Calls the injected planner and keeps the frozen route.
 * Provider URL and key never become part of the Pi prompt.
 */
export async function recordPiModelRoute(input: {
  readonly planner: PiModelBindingPlannerPort;
  readonly harness: PiPlannerHarness;
  readonly turnId: string;
  readonly bind: PiTurnBindContext;
}): Promise<PiRouteDecision> {
  const planned = await input.planner.plan({
    spec: input.bind.spec,
    target: input.bind.target,
    harness: input.harness,
    catalog: input.bind.catalog,
    ...(input.bind.executor ? { executor: input.bind.executor } : {}),
    ...(input.bind.startupOverrides ? { startupOverrides: input.bind.startupOverrides } : {}),
  });
  return decide(
    input.bind.spec,
    input.turnId,
    input.bind.catalog,
    input.bind.executor,
    planned,
    input.harness,
  );
}

function decide(
  spec: SessionSpec,
  turnId: string,
  catalog: PiPlannerCatalog,
  executor: { readonly providerId: string; readonly modelId: string } | undefined,
  plan: PiPlannerBinding,
  harness: PiPlannerHarness,
): PiRouteDecision {
  const base = baseRecord(spec, turnId, plan);
  if (plan.catalogFingerprint !== catalog.fingerprint) {
    return reject(base, "model catalog changed since binding plan");
  }
  if (
    plan.startupOverrides.applied !== false ||
    plan.startupOverrides.credentialInjection !== "refused"
  ) {
    return reject(base, "CLI startup must not receive a provider URL or key");
  }
  if (plan.support.support !== "supported") {
    return reject(base, publicText(plan.support.reason, "binding plan rejected"));
  }
  if (!plan.versionFingerprint || SECRET_TEXT.test(plan.versionFingerprint)) {
    return reject(base, "binding plan version fingerprint is missing");
  }
  const credential = credentialRef(plan.credentialRef);
  if (!credential.ok) return reject(base, credential.reason);
  if (plan.kind === "harness-managed") {
    if (
      plan.unifiedModelRouting !== false ||
      plan.route !== "harness-managed" ||
      plan.execution.kind !== "harness-managed"
    ) {
      return reject(base, "harness-managed binding cannot use unified model routing");
    }
    const nativeModelId =
      spec.modelBinding.kind === "harness-managed" ? spec.modelBinding.nativeModelId : undefined;
    return accept(base, plan, credential.ref, {
      kind: "harness-managed",
      ...(nativeModelId ? { nativeModelId } : {}),
      versionFingerprint: plan.versionFingerprint,
    });
  }
  const requested = plan.requested.kind === "host-managed" ? plan.requested.selection : undefined;
  if (
    !requested ||
    !plan.effective ||
    plan.unifiedModelRouting !== true ||
    plan.execution.kind !== "existing-model-runtime"
  ) {
    return reject(base, "host-managed binding did not use the existing model runtime");
  }
  if (
    requested.providerId !== plan.effective.providerId ||
    requested.modelId !== plan.effective.modelId
  ) {
    return reject(base, "requested and effective model routes differ");
  }
  if (
    executor &&
    (executor.providerId !== plan.effective.providerId ||
      executor.modelId !== plan.effective.modelId)
  ) {
    return reject(base, "existing model executor route does not match the requested model");
  }
  if (!harness.hostManagedRoute || plan.route !== harness.hostManagedRoute) {
    return reject(base, "host-managed route is not the Pi control route");
  }
  return accept(base, plan, credential.ref, {
    kind: "host-managed",
    route: plan.route,
    providerId: plan.effective.providerId,
    modelId: plan.effective.modelId,
    ...(credential.ref ? { credentialRef: credential.ref } : {}),
    versionFingerprint: plan.versionFingerprint,
  });
}

function baseRecord(spec: SessionSpec, turnId: string, plan: PiPlannerBinding): PiModelRouteRecord {
  const requested = plan.requested.kind === "host-managed" ? plan.requested.selection : undefined;
  return {
    hostSessionId: spec.hostSessionId,
    turnId,
    kind: plan.kind,
    unifiedModelRouting: false,
    ...(plan.route && !SECRET_TEXT.test(plan.route) ? { route: plan.route } : {}),
    ...(requested
      ? { requestedProviderId: requested.providerId, requestedModelId: requested.modelId }
      : {}),
    capabilities: publicCapabilities(plan.capabilities),
    catalogFingerprint: plan.catalogFingerprint,
    versionFingerprint: SECRET_TEXT.test(plan.versionFingerprint) ? "" : plan.versionFingerprint,
    accepted: false,
  };
}

function accept(
  base: PiModelRouteRecord,
  plan: PiPlannerBinding,
  credentialRef: string | undefined,
  hint: PiModelHint,
): PiRouteDecision {
  const record: PiModelRouteRecord = {
    ...base,
    unifiedModelRouting: plan.unifiedModelRouting,
    ...(plan.effective
      ? { effectiveProviderId: plan.effective.providerId, effectiveModelId: plan.effective.modelId }
      : {}),
    ...(credentialRef ? { credentialRef } : {}),
    versionFingerprint: plan.versionFingerprint,
    accepted: true,
  };
  return { record: freeze(record), hint: freeze(hint) };
}

function reject(base: PiModelRouteRecord, reason: string): PiRouteDecision {
  return {
    record: freeze({
      ...base,
      accepted: false,
      reason: publicText(reason, "binding plan rejected"),
    }),
  };
}

function credentialRef(
  value: string | undefined,
): { ok: true; ref?: string } | { ok: false; reason: string } {
  if (!value) return { ok: true };
  if (!SAFE_REF.test(value) || SECRET_TEXT.test(value)) {
    return { ok: false, reason: "credential reference must stay an opaque id" };
  }
  return { ok: true, ref: value };
}

function publicCapabilities(
  capabilities: PiPlannerBinding["capabilities"],
): PiModelRouteRecord["capabilities"] {
  return Object.fromEntries(
    Object.entries(capabilities).map(([key, report]) => [
      key,
      {
        support: report.support,
        ...(report.reason
          ? { reason: publicText(report.reason, "capability reason redacted") }
          : {}),
      },
    ]),
  );
}

function publicText(value: string | undefined, fallback: string): string {
  if (!value || SECRET_TEXT.test(value)) return fallback;
  return value.slice(0, 1024);
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}
