import type {
  AgentCommandReceipt,
  AgentEvent,
  CapabilityReport,
  ExecutionTarget,
  HarnessCapabilities,
  SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";

/** Frames the host sends. They carry route identity only, never a provider URL or key. */
export type PiHostFrame =
  | { type: "session.open"; hostSessionId: string; runtimeEpoch: string }
  | { type: "turn.prompt"; turnId: string; text: string; model: PiModelHint }
  | { type: "turn.cancel"; turnId: string; runtimeEpoch: string }
  | {
      type: "approval.decision";
      turnId: string;
      interactionId: string;
      decision: "allow" | "deny";
    }
  | { type: "session.terminate"; hostSessionId: string };

export type PiModelHint =
  | {
      kind: "host-managed";
      route: string;
      providerId: string;
      modelId: string;
      credentialRef?: string;
      versionFingerprint: string;
    }
  | { kind: "harness-managed"; nativeModelId?: string; versionFingerprint: string };

/** Frames a Pi process sends back. This module does not produce them by running Pi's loop. */
export type PiPeerFrame =
  | { type: "session.ready"; backendSessionId: string }
  | {
      type: "text.delta";
      turnId: string;
      messageId: string;
      text: string;
      sourceEventId: string;
    }
  | {
      type: "message.snapshot";
      turnId: string;
      messageId: string;
      role: "assistant" | "user";
      text: string;
      sourceEventId: string;
    }
  | {
      type: "tool.pending";
      turnId: string;
      toolCallId: string;
      name: string;
      summary: string;
      sourceEventId: string;
    }
  | {
      type: "tool.result";
      turnId: string;
      toolCallId: string;
      name: string;
      outcome: "success" | "error" | "cancelled";
      outputText?: string;
      file?: { path: string; additions: number; deletions: number };
      sourceEventId: string;
    }
  | {
      type: "usage";
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      sourceEventId: string;
    }
  | {
      type: "turn.done";
      turnId: string;
      outcome: "success" | "cancelled" | "failed" | "unknown";
      sourceEventId: string;
    };

export type PiRpcFrame = PiHostFrame | PiPeerFrame;

export interface PiCapabilityNote {
  readonly support: "supported" | "unsupported" | "experimental" | "unknown";
  readonly reason?: string;
}

/** Structural slice of ModelBindingPlanner's frozen plan. This file does not plan. */
export interface PiPlannerBinding {
  readonly kind: "host-managed" | "harness-managed";
  readonly unifiedModelRouting: boolean;
  readonly hostManagedCertification: "complete" | "incomplete" | "not-applicable";
  readonly route?: string;
  readonly requested: SessionSpec["modelBinding"];
  readonly effective?: ModelSelection;
  readonly support: PiCapabilityNote;
  readonly capabilities: {
    readonly tools: PiCapabilityNote;
    readonly images: PiCapabilityNote;
    readonly reasoning: PiCapabilityNote;
    readonly resume: PiCapabilityNote;
    readonly modelSwitch: PiCapabilityNote;
    readonly backgroundCalls: PiCapabilityNote;
  };
  readonly credentialRef?: string;
  readonly credentialSource?: "provider-api-key" | "provider-account";
  readonly startupOverrides: {
    readonly applied: boolean;
    readonly credentialInjection: string;
    readonly reason: string;
  };
  readonly catalogFingerprint: string;
  readonly versionFingerprint: string;
  readonly execution: { readonly kind: "existing-model-runtime" | "harness-managed" | "unbound" };
}

export interface PiPlannerCatalog {
  readonly fingerprint: string;
  validateSelection(selection: ModelSelection): { ok: true } | { ok: false; reason: string };
  credentialRef?(selection: ModelSelection): string | undefined;
  credentialSource?(selection: ModelSelection): "provider-api-key" | "provider-account" | undefined;
}

export interface PiPlannerHarness {
  readonly id: string;
  readonly version: string;
  readonly hostManagedRoute?: string;
  probe(target: ExecutionTarget): Promise<CapabilityReport>;
  capabilities(target: ExecutionTarget): Promise<HarnessCapabilities>;
  hostManagedSupport(target: ExecutionTarget, selection: ModelSelection): Promise<CapabilityReport>;
  harnessManagedSupport?(
    target: ExecutionTarget,
    nativeModelId?: string,
  ): Promise<CapabilityReport>;
}

export interface PiModelBindingPlannerPort {
  plan(input: {
    readonly spec: SessionSpec;
    readonly target: ExecutionTarget;
    readonly harness: PiPlannerHarness;
    readonly catalog: PiPlannerCatalog;
    readonly executor?: { readonly providerId: string; readonly modelId: string };
    readonly startupOverrides?: Readonly<Record<string, unknown>>;
  }): Promise<PiPlannerBinding>;
}

export interface PiModelRouteRecord {
  readonly hostSessionId: string;
  readonly turnId: string;
  readonly kind: "host-managed" | "harness-managed";
  readonly unifiedModelRouting: boolean;
  readonly route?: string;
  readonly requestedProviderId?: string;
  readonly requestedModelId?: string;
  readonly effectiveProviderId?: string;
  readonly effectiveModelId?: string;
  readonly capabilities: Readonly<Record<string, PiCapabilityNote>>;
  readonly credentialRef?: string;
  readonly catalogFingerprint: string;
  readonly versionFingerprint: string;
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface PiTurnBindContext {
  readonly spec: SessionSpec;
  readonly target: ExecutionTarget;
  readonly catalog: PiPlannerCatalog;
  readonly executor?: { readonly providerId: string; readonly modelId: string };
  readonly startupOverrides?: Readonly<Record<string, unknown>>;
}

export interface PiCommandResult {
  readonly receipt: AgentCommandReceipt;
  readonly events?: readonly AgentEvent[];
}
