import {
  capabilityReportSchema,
  executionTargetSchema,
  type BindingPlan,
  type CapabilityReport,
  type ExecutionTarget,
} from "@zcode/shared/agent-host";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { MODEL_GATEWAY_VERSION } from "../contract.js";

const DISABLED_RESPONSES_REASONING = new Set(["none", "off", "disabled"]);

export type GatewayCompatibilityRoute = NonNullable<BindingPlan["route"]> | "chat-completions";

export interface ModelGatewayCompatibilityRow {
  readonly gatewayVersion: typeof MODEL_GATEWAY_VERSION;
  readonly harnessId: string;
  readonly harnessVersion: string;
  readonly modelSource: Pick<ModelSelection, "providerId" | "modelId">;
  readonly parameters: { readonly reasoningLevel?: string };
  readonly targetKind: ExecutionTarget["kind"];
  readonly targetPlatform: ExecutionTarget["platform"];
  readonly route: GatewayCompatibilityRoute;
  readonly report: CapabilityReport;
}

export function describeGatewayCompatibility(input: {
  readonly harnessId: string;
  readonly harnessVersion: string;
  readonly modelSource: ModelSelection;
  readonly target: ExecutionTarget;
  readonly route: GatewayCompatibilityRoute;
}): ModelGatewayCompatibilityRow {
  const harnessId = boundedIdentity(input.harnessId, "harness id");
  const harnessVersion = boundedIdentity(input.harnessVersion, "harness version");
  const target = executionTargetSchema.safeParse(input.target);
  const modelSource = modelSelectionSchema.safeParse(input.modelSource);
  if (!target.success || !modelSource.success) throw new Error("compatibility input is invalid");
  const reasoningLevel = modelSource.data.options?.reasoningLevel;
  const row = {
    gatewayVersion: MODEL_GATEWAY_VERSION,
    harnessId,
    harnessVersion,
    modelSource: { providerId: modelSource.data.providerId, modelId: modelSource.data.modelId },
    parameters: reasoningLevel === undefined ? {} : { reasoningLevel },
    targetKind: target.data.kind,
    targetPlatform: target.data.platform,
    route: input.route,
    report: reportFor(input.route, target.data, reasoningLevel),
  } satisfies ModelGatewayCompatibilityRow;
  return { ...row, report: capabilityReportSchema.parse(row.report) };
}

function reportFor(
  route: GatewayCompatibilityRoute,
  target: ExecutionTarget,
  reasoningLevel: string | undefined,
): CapabilityReport {
  if (!target.available) {
    return { support: "unsupported", reason: target.reason ?? "target unavailable" };
  }
  if (route === "chat-completions") {
    return {
      support: "unsupported",
      reason: "Chat Completions has no harness ingress requirement",
    };
  }
  if (route !== "responses-gateway" && route !== "pi-sdk" && route !== "messages-gateway") {
    return { support: "unsupported", reason: "route is not served by Model Gateway" };
  }
  // SSH 保持 experimental。FakeModel 只证明共享 Gateway 注入，不认证远端凭据。
  if (target.kind === "ssh") {
    return {
      support: "experimental",
      reason:
        "loopback Gateway must run on the target host; remote credential paths are not certified",
    };
  }
  if (route === "messages-gateway") {
    return {
      support: "experimental",
      reason:
        "Messages HTTP ingress does not certify a live Provider chain. Responses admits a supported host-managed plan on this route only through the existing Model runtime.",
    };
  }
  if (!reasoningLevel || !DISABLED_RESPONSES_REASONING.has(reasoningLevel)) {
    return {
      support: "unsupported",
      reason: "Responses slice requires an explicit disabled reasoning parameter",
    };
  }
  return {
    support: "supported",
    constraints: {
      images: "unsupported",
      promptCache: "accepted-not-forwarded",
      chatCompletions: "unsupported",
      privateReasoning: "rejected",
      contextCompaction: "unsupported",
    },
  };
}

function boundedIdentity(value: string, label: string): string {
  if (value !== value.trim() || value.length < 1 || value.length > 128) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
