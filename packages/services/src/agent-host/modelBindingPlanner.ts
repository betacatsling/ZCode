/* eslint-disable max-lines -- wire admission 与 BindingPlan 必须留在本文件；任务不允许再拆新模块。 */
import { createHash } from "node:crypto";
import type { Model } from "@zcode/contracts";
import {
  bindingPlanSchema,
  type BindingPlan as WireBindingPlan,
  type CapabilityReport,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { HarnessAdapter } from "./harnessRegistry.js";

export interface ModelCatalogPort {
  readonly fingerprint: string;
  validateSelection(selection: ModelSelection): { ok: true } | { ok: false; reason: string };
  /** Captures one immutable registry view for planning, validation, and Model construction. */
  capture?(): ModelCatalogSnapshotPort;
}

export interface ModelCatalogSnapshotPort {
  readonly fingerprint: string;
  validateSelection(selection: ModelSelection): { ok: true } | { ok: false; reason: string };
  bindModel?(
    plan: WireBindingPlan,
  ): Promise<import("@zcode/contracts").Model> | import("@zcode/contracts").Model;
  isCurrent?(): boolean;
  credentialSource?(selection: ModelSelection): "provider-api-key" | "provider-account" | undefined;
  /** Opaque id only. Callers must not pass a key, token, or provider URL. */
  credentialRef?(selection: ModelSelection): string | undefined;
}

/** Pure admission decision except adapter capability probes; never substitutes a default model. */
export async function planModelBinding(input: {
  spec: SessionSpec;
  target: ExecutionTarget;
  harness: HarnessAdapter;
  catalog: ModelCatalogSnapshotPort;
}): Promise<WireBindingPlan> {
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
  const reject = (reason: string): WireBindingPlan =>
    bindingPlanSchema.parse({
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
      ...common,
      route: "harness-managed",
      support,
      capabilities,
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
    ...(catalog.credentialSource?.(selection)
      ? { credentialSource: catalog.credentialSource(selection) }
      : {}),
    effective: selection,
    support,
    capabilities,
  });
}

/**
 * Identity slice of the existing `@zcode/contracts` Model.
 * `ApiProviderModelRuntime` and `@zcode/adapters/model` create that Model.
 * This planner only reads the identity; it does not call generateText, streamText, or bind.
 */
export type ExistingModelExecutor = Pick<Model, "providerId" | "modelId"> &
  Partial<Pick<Model, "properties" | "optionSpecs" | "options">>;

export interface BindingCapabilityReport {
  readonly support: "supported" | "unsupported" | "experimental" | "unknown";
  readonly reason?: string;
  readonly constraints?: Readonly<Record<string, unknown>>;
}

type BindingKind = "host-managed" | "harness-managed";
type HostRoute = "native" | "pi-sdk" | "responses-gateway" | "messages-gateway" | "mock";

/**
 * In-memory compatibility decision. It is not a secret store and not a second model client.
 * host-managed calls the existing model runtime, directly or through a gateway ingress.
 * harness-managed means the agent owns its model and account.
 */
export interface BindingPlan {
  readonly schemaVersion: 1;
  readonly kind: BindingKind;
  readonly unifiedModelRouting: boolean;
  readonly hostManagedCertification: "complete" | "incomplete" | "not-applicable";
  readonly hostSessionId: string;
  readonly targetId: string;
  readonly targetPlatform: ExecutionTarget["platform"];
  readonly harnessId: string;
  readonly adapterVersion: string;
  readonly route?: HostRoute | "harness-managed";
  readonly requested: SessionSpec["modelBinding"];
  readonly effective?: ModelSelection;
  readonly roles: {
    readonly main?: ModelSelection;
    readonly compact?: ModelSelection;
    readonly subtask?: ModelSelection;
    readonly explicit: boolean;
  };
  readonly support: BindingCapabilityReport;
  readonly capabilities: {
    readonly tools: BindingCapabilityReport;
    readonly images: BindingCapabilityReport;
    readonly reasoning: BindingCapabilityReport;
    readonly resume: BindingCapabilityReport;
    readonly modelSwitch: BindingCapabilityReport;
    readonly backgroundCalls: BindingCapabilityReport;
  };
  readonly credentialRef?: string;
  readonly credentialSource?: "provider-api-key" | "provider-account";
  readonly startupOverrides: {
    readonly applied: false;
    readonly credentialInjection: "refused";
    readonly reason: string;
  };
  readonly catalogFingerprint: string;
  readonly versionFingerprint: string;
  readonly gatewayVersion?: string;
  readonly limits: {
    readonly modelSwitch: "in-turn" | "next-turn-or-new-session";
    readonly opaqueStateMigration: "not-requested" | "refused";
  };
  readonly execution:
    | { readonly kind: "existing-model-runtime" }
    | { readonly kind: "harness-managed" }
    | { readonly kind: "unbound" };
}

export interface ModelBindingPlannerInput {
  readonly spec: SessionSpec;
  readonly target: ExecutionTarget;
  readonly harness: HarnessAdapter;
  readonly catalog: ModelCatalogSnapshotPort;
  readonly executor?: ExistingModelExecutor;
  readonly roles?: { readonly compact?: ModelSelection; readonly subtask?: ModelSelection };
  readonly explicitRoleConfiguration?: boolean;
  readonly backgroundCalls?: BindingCapabilityReport;
  readonly gatewayVersion?: string;
  readonly startupOverrides?: Readonly<Record<string, unknown>>;
  readonly previous?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly carryOpaqueState?: boolean;
  };
}

function isHostRoute(route: string): route is HostRoute {
  return (HOST_ROUTES as ReadonlySet<string>).has(route);
}

const HOST_ROUTES = new Set<HostRoute>([
  "native",
  "pi-sdk",
  "responses-gateway",
  "messages-gateway",
  "mock",
]);
const GATEWAY_ROUTES = new Set<HostRoute>(["responses-gateway", "messages-gateway"]);
const SECRET_KEY =
  /api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret|password|base[-_]?url|provider[-_]?url|upstream[-_]?url|^bearer$|^endpoint$|^token$/i;
const SECRET_TEXT = /sk-|bearer\s+|https?:\/\//i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
const STARTUP = {
  applied: false as const,
  credentialInjection: "refused" as const,
  reason: "provider URL and key stay in the model service; CLI startup does not receive them",
};

/**
 * owner: 目录与凭据仍由调用方持有的 catalog / 模型服务；本对象不缓存、不落盘。
 * path: snapshot → probe → 现有 Model 身份核对 → 冻结 BindingPlan。
 * 下一轮必须重新 plan。桌面实时链路和手机重放链路都只读取这份不可变结果。
 */
export class ModelBindingPlanner {
  async plan(input: ModelBindingPlannerInput): Promise<BindingPlan> {
    const decided = await decideBinding(input);
    if (containsSecret(decided)) {
      return rejectPlan(input, "binding plan dropped secret material");
    }
    return decided;
  }
}

async function decideBinding(input: ModelBindingPlannerInput): Promise<BindingPlan> {
  const { spec, target, harness } = input;
  if (target.id !== spec.execution.targetId || !target.available) {
    return rejectPlan(input, target.reason ?? "target-unavailable or target identity mismatch");
  }
  if (harness.id !== spec.harness.id || harness.version !== spec.harness.adapterVersion) {
    return rejectPlan(input, "harness identity or adapter version mismatch");
  }
  if (findSecret(input.startupOverrides)) {
    return rejectPlan(
      input,
      "writing a provider URL or key into CLI configuration is not a host-managed binding",
    );
  }
  const probe = await harness.probe(target);
  if (probe.support !== "supported") return rejectPlan(input, probe.reason ?? "harness not ready");
  const reported = await harness.capabilities(target);
  if (spec.modelBinding.kind === "harness-managed") return planHarnessManaged(input, reported);
  return planHostManaged(input, reported);
}

async function planHarnessManaged(
  input: ModelBindingPlannerInput,
  reported: HarnessCapabilities,
): Promise<BindingPlan> {
  const nativeModelId =
    input.spec.modelBinding.kind === "harness-managed"
      ? input.spec.modelBinding.nativeModelId
      : undefined;
  const support = await input.harness.harnessManagedSupport?.(input.target, nativeModelId);
  if (support?.support !== "supported") {
    return rejectPlan(input, support?.reason ?? "harness native-account route is not certified");
  }
  const opaque = opaqueLimit(input, undefined);
  if (opaque === "blocked") {
    return rejectPlan(
      input,
      "cross-provider private inference state cannot be migrated",
      "refused",
    );
  }
  return finish(input, {
    kind: "harness-managed",
    route: "harness-managed",
    unifiedModelRouting: false,
    hostManagedCertification: "not-applicable",
    support: copyReport(support, "harness-managed route is not certified"),
    capabilities: capabilityMap(reported, undefined, input.backgroundCalls),
    execution: { kind: "harness-managed" },
    limits: limitsFor(reported, opaque),
  });
}

async function planHostManaged(
  input: ModelBindingPlannerInput,
  reported: HarnessCapabilities,
): Promise<BindingPlan> {
  const selection =
    input.spec.modelBinding.kind === "host-managed" ? input.spec.modelBinding.selection : undefined;
  if (!selection) return rejectPlan(input, "host-managed selection is missing");
  if (opaqueLimit(input, selection) === "blocked") {
    return rejectPlan(
      input,
      "cross-provider private inference state cannot be migrated",
      "refused",
    );
  }
  const validated = input.catalog.validateSelection(selection);
  if (!validated.ok) return rejectPlan(input, validated.reason);
  const route = input.harness.hostManagedRoute;
  if (!route || !isHostRoute(route)) {
    return rejectPlan(input, "host-managed route is not certified");
  }
  const support = await input.harness.hostManagedSupport(input.target, selection);
  if (support.support !== "supported") {
    return rejectPlan(input, support.reason ?? "host-managed route is not certified");
  }
  const gatewayVersion = input.gatewayVersion?.trim();
  if (GATEWAY_ROUTES.has(route) && !gatewayVersion) {
    return rejectPlan(
      input,
      "gateway compatibility requires a gateway version in the binding fingerprint",
    );
  }
  const bound = input.executor;
  if (bound && (bound.providerId !== selection.providerId || bound.modelId !== selection.modelId)) {
    return rejectPlan(input, "existing model executor route does not match the requested model");
  }
  const roles = resolveRoles(input, selection);
  if ("error" in roles) return rejectPlan(input, roles.error);
  const credential = resolveCredential(input, selection);
  if ("error" in credential) return rejectPlan(input, credential.error);
  const capabilities = capabilityMap(reported, bound, input.backgroundCalls, selection);
  const certification =
    capabilities.backgroundCalls.support === "supported" && bound ? "complete" : "incomplete";
  return finish(input, {
    kind: "host-managed",
    route,
    unifiedModelRouting: true,
    hostManagedCertification: certification,
    requestedSelection: selection,
    effective: copySelection(selection),
    roles,
    support: { support: "supported" },
    capabilities,
    ...(credential.ref ? { credentialRef: credential.ref } : {}),
    ...(credential.source ? { credentialSource: credential.source } : {}),
    ...(gatewayVersion ? { gatewayVersion } : {}),
    execution: { kind: "existing-model-runtime" },
    limits: limitsFor(
      reported,
      opaqueLimit(input, selection) === "refused" ? "refused" : "not-requested",
    ),
  });
}

interface PlannedBody {
  readonly kind: BindingKind;
  readonly route?: BindingPlan["route"];
  readonly unifiedModelRouting: boolean;
  readonly hostManagedCertification: BindingPlan["hostManagedCertification"];
  readonly requestedSelection?: ModelSelection;
  readonly effective?: ModelSelection;
  readonly roles?: BindingPlan["roles"];
  readonly support: BindingCapabilityReport;
  readonly capabilities: BindingPlan["capabilities"];
  readonly credentialRef?: string;
  readonly credentialSource?: BindingPlan["credentialSource"];
  readonly gatewayVersion?: string;
  readonly execution: BindingPlan["execution"];
  readonly limits: BindingPlan["limits"];
}

function finish(input: ModelBindingPlannerInput, body: PlannedBody): BindingPlan {
  const roles = body.roles ?? { explicit: false };
  const fingerprint = versionFingerprint({
    kind: body.kind,
    route: body.route,
    host: input.spec.hostSessionId,
    target: input.target.id,
    platform: input.target.platform,
    harness: input.spec.harness.id,
    adapter: input.harness.version,
    catalog: input.catalog.fingerprint,
    provider: body.effective?.providerId,
    model: body.effective?.modelId,
    reasoning: body.effective?.options?.reasoningLevel,
    compact: body.roles?.compact
      ? `${body.roles.compact.providerId}/${body.roles.compact.modelId}`
      : undefined,
    subtask: body.roles?.subtask
      ? `${body.roles.subtask.providerId}/${body.roles.subtask.modelId}`
      : undefined,
    credential: body.credentialRef,
    source: body.credentialSource,
    gateway: body.gatewayVersion,
    certification: body.hostManagedCertification,
    background: body.capabilities.backgroundCalls.support,
  });
  return freezePlan({
    schemaVersion: 1,
    kind: body.kind,
    unifiedModelRouting: body.unifiedModelRouting,
    hostManagedCertification: body.hostManagedCertification,
    hostSessionId: input.spec.hostSessionId,
    targetId: input.target.id,
    targetPlatform: input.target.platform,
    harnessId: input.spec.harness.id,
    adapterVersion: input.harness.version,
    ...(body.route ? { route: body.route } : {}),
    requested: copyRequested(input.spec.modelBinding),
    ...(body.effective ? { effective: body.effective } : {}),
    roles,
    support: body.support,
    capabilities: body.capabilities,
    ...(body.credentialRef ? { credentialRef: body.credentialRef } : {}),
    ...(body.credentialSource ? { credentialSource: body.credentialSource } : {}),
    startupOverrides: STARTUP,
    catalogFingerprint: input.catalog.fingerprint,
    versionFingerprint: fingerprint,
    ...(body.gatewayVersion ? { gatewayVersion: body.gatewayVersion } : {}),
    limits: body.limits,
    execution: body.execution,
  });
}

function rejectPlan(
  input: ModelBindingPlannerInput,
  reason: string,
  opaque: BindingPlan["limits"]["opaqueStateMigration"] = "not-requested",
): BindingPlan {
  const kind = input.spec.modelBinding.kind;
  const capabilities = unknownCapabilities(reason);
  return finish(input, {
    kind,
    unifiedModelRouting: false,
    hostManagedCertification: kind === "harness-managed" ? "not-applicable" : "incomplete",
    support: { support: "unsupported", reason },
    capabilities,
    execution: { kind: "unbound" },
    limits: { modelSwitch: "next-turn-or-new-session", opaqueStateMigration: opaque },
  });
}

function resolveRoles(
  input: ModelBindingPlannerInput,
  selection: ModelSelection,
): BindingPlan["roles"] | { error: string } {
  const compact = input.roles?.compact ?? selection;
  const subtask = input.roles?.subtask ?? selection;
  const explicit = !sameSelection(compact, selection) || !sameSelection(subtask, selection);
  if (explicit && input.explicitRoleConfiguration !== true) {
    return { error: "model roles must resolve to the same selection unless explicitly configured" };
  }
  if (explicit) {
    for (const role of [compact, subtask]) {
      const result = input.catalog.validateSelection(role);
      if (!result.ok) return { error: result.reason };
    }
  }
  return {
    explicit,
    main: copySelection(selection),
    compact: copySelection(compact),
    subtask: copySelection(subtask),
  };
}

function resolveCredential(
  input: ModelBindingPlannerInput,
  selection: ModelSelection,
): { ref?: string; source?: BindingPlan["credentialSource"] } | { error: string } {
  const source = input.catalog.credentialSource?.(selection);
  const provided = input.catalog.credentialRef?.(selection);
  const ref = provided ?? (source ? `ref.${source}.${selection.providerId}` : undefined);
  if (ref && (!SAFE_REF.test(ref) || SECRET_TEXT.test(ref))) {
    return { error: "credential reference must stay an opaque id" };
  }
  return { ...(ref ? { ref } : {}), ...(source ? { source } : {}) };
}

function capabilityMap(
  reported: HarnessCapabilities,
  executor: ExistingModelExecutor | undefined,
  background: BindingCapabilityReport | undefined,
  selection?: ModelSelection,
): BindingPlan["capabilities"] {
  return {
    tools: narrow(
      copyReport(reported.tools, "harness did not report tool support"),
      executor?.properties?.supportsToolCall === false,
      "existing model runtime does not support tool calls",
    ),
    images: narrow(
      copyReport(reported.images, "harness did not report image support"),
      executor?.properties?.inputFormat?.supportsImage === false,
      "existing model runtime does not support image input",
    ),
    reasoning: selection
      ? reasoningReport(selection, executor)
      : { support: "unknown", reason: "reasoning is not certified by the existing model executor" },
    resume: copyReport(reported.resumeExecution, "harness did not report resume support"),
    modelSwitch: copyReport(reported.modelSwitch, "harness did not report model switch support"),
    backgroundCalls: background
      ? copyReport(background, "uncontrolled background or auxiliary model calls are not certified")
      : {
          support: "unknown",
          reason: "uncontrolled background or auxiliary model calls are not certified",
        },
  };
}

function reasoningReport(
  selection: ModelSelection,
  executor: ExistingModelExecutor | undefined,
): BindingCapabilityReport {
  if (!executor) {
    return {
      support: "unknown",
      reason: "reasoning is not certified by the existing model executor",
    };
  }
  const level = selection.options?.reasoningLevel;
  if (!level)
    return { support: "unknown", reason: "requested model did not select a reasoning level" };
  const values = executor.optionSpecs?.reasoningLevel?.values;
  if (values && !values.includes(level)) {
    return {
      support: "unsupported",
      reason: "existing model executor does not list the requested reasoning level",
    };
  }
  if (executor.options?.reasoningLevel && executor.options.reasoningLevel !== level) {
    return {
      support: "unsupported",
      reason: "existing model executor reasoning level does not match the requested selection",
    };
  }
  return { support: "supported" };
}

function opaqueLimit(
  input: ModelBindingPlannerInput,
  selection: ModelSelection | undefined,
): "not-requested" | "refused" | "blocked" {
  const previous = input.previous;
  if (!previous?.carryOpaqueState) return "not-requested";
  if (
    !selection ||
    previous.providerId !== selection.providerId ||
    previous.modelId !== selection.modelId
  ) {
    return "blocked";
  }
  return "refused";
}

function limitsFor(
  reported: HarnessCapabilities,
  opaque: "not-requested" | "refused",
): BindingPlan["limits"] {
  return {
    modelSwitch:
      reported.modelSwitch.support === "supported" ? "in-turn" : "next-turn-or-new-session",
    opaqueStateMigration: opaque,
  };
}

function unknownCapabilities(reason: string): BindingPlan["capabilities"] {
  const report = { support: "unknown" as const, reason };
  return {
    tools: report,
    images: report,
    reasoning: report,
    resume: report,
    modelSwitch: report,
    backgroundCalls: report,
  };
}

function narrow(
  report: BindingCapabilityReport,
  blocked: boolean,
  reason: string,
): BindingCapabilityReport {
  if (!blocked || report.support === "unsupported") return report;
  return { support: "unsupported", reason };
}

function copyReport(
  report: CapabilityReport | BindingCapabilityReport | undefined,
  fallback: string,
): BindingCapabilityReport {
  if (!report) return { support: "unknown", reason: fallback };
  const reason = report.support === "supported" ? report.reason : (report.reason ?? fallback);
  return {
    support: report.support,
    ...(reason ? { reason } : {}),
    ...(report.constraints ? { constraints: { ...report.constraints } } : {}),
  };
}

function copySelection(selection: ModelSelection): ModelSelection {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

function copyRequested(binding: SessionSpec["modelBinding"]): SessionSpec["modelBinding"] {
  if (binding.kind === "harness-managed") {
    return binding.nativeModelId
      ? { kind: "harness-managed", nativeModelId: binding.nativeModelId }
      : { kind: "harness-managed" };
  }
  return { kind: "host-managed", selection: copySelection(binding.selection) };
}

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    (left.options?.reasoningLevel ?? "") === (right.options?.reasoningLevel ?? "")
  );
}

function versionFingerprint(fields: Readonly<Record<string, string | undefined>>): string {
  const lines = Object.keys(fields)
    .filter((key) => fields[key] !== undefined)
    .sort()
    .map((key) => `${key}=${fields[key]}`);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function findSecret(value: unknown): boolean {
  if (typeof value === "string") return SECRET_TEXT.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => SECRET_KEY.test(key) || findSecret(nested));
}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return SECRET_TEXT.test(value);
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((nested) => containsSecret(nested));
}

function freezePlan<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freezePlan(nested);
    Object.freeze(value);
  }
  return value;
}
