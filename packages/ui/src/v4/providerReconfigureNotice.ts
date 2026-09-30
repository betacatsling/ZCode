import type { AgentModelFailure } from "@zcode/shared/agent-host";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";

/** Host reason code for a Provider whose credential was rejected and not reconfigured since. */
export const PROVIDER_RECONFIGURE_REQUIRED = "provider-reconfigure-required";

export type ProviderReconfigureNoticeSource = "session-error" | "command-receipt" | "capability";

/**
 * Key-free description of a "reconfigure this Provider" hint. It only carries identifiers;
 * messages, keys, and endpoints from the Host are never copied in.
 */
export interface ProviderReconfigureNoticeModel {
  source: ProviderReconfigureNoticeSource;
  providerId: string;
  modelId?: string;
  /** Stable identity for local dismissal; a new error/receipt/attention gets a new key. */
  key: string;
}

/** A rejected command receipt remembered by the pane (ids and the key-free typed cause only). */
export interface ProviderReconfigureReceipt {
  sessionId: string;
  commandId: string;
  /** Typed cause from the V4 ack; older hosts omit it. */
  failure?: AgentModelFailure;
}

/**
 * Pick the rejected send receipt that asks for a Provider reconfigure. Newer hosts attach the
 * typed failure to the V4 CommandAck; older ones only send the reasonCode.
 */
export function providerReconfigureReceiptFromAck(
  ack: { commandId: string; status: string; reasonCode?: string; failure?: AgentModelFailure },
  sessionId: string | null,
): ProviderReconfigureReceipt | null {
  if (!sessionId || ack.status !== "rejected" || ack.reasonCode !== PROVIDER_RECONFIGURE_REQUIRED)
    return null;
  return { sessionId, commandId: ack.commandId, ...(ack.failure ? { failure: ack.failure } : {}) };
}

/** Provider/model the hint names: the typed failure's own Provider, else the session config. */
function noticeTarget(
  failure: AgentModelFailure | undefined,
  sessionProviderId: string,
  sessionModelId: string | undefined,
): { providerId: string; modelId?: string } {
  if (failure?.action === "reconfigure-provider" && failure.providerId.trim())
    return {
      providerId: failure.providerId,
      ...(failure.modelId ? { modelId: failure.modelId } : {}),
    };
  return { providerId: sessionProviderId, ...(sessionModelId ? { modelId: sessionModelId } : {}) };
}

/**
 * Resolve the hint from the three places the Host reports it:
 * - capability `credentialAttention` (typed, names the Provider itself);
 * - a rejected command receipt for this session;
 * - the projected session.error (`control.lastError`) while the session is still in error.
 * Receipt and session.error name the typed failure's Provider when the host sent one (any
 * status code, e.g. non-retryable 403 too), else the session's host-managed `config.provider`.
 * Harness-managed sessions project an empty provider and never get a hint.
 */
export function resolveProviderReconfigureNotice(input: {
  sessionId: string | null;
  phase?: string | null;
  lastError?: { code: string; at?: number; failure?: AgentModelFailure } | null;
  receipt?: ProviderReconfigureReceipt | null;
  sessionProviderId?: string | null;
  sessionModelId?: string | null;
  capabilityAttention?: AgentModelFailure | null;
}): ProviderReconfigureNoticeModel | null {
  const attention = input.capabilityAttention;
  if (attention?.action === "reconfigure-provider" && attention.providerId.trim()) {
    return {
      source: "capability",
      providerId: attention.providerId,
      ...(attention.modelId ? { modelId: attention.modelId } : {}),
      key: `capability:${attention.providerId}:${attention.modelId ?? ""}`,
    };
  }
  const sessionProviderId = input.sessionProviderId?.trim();
  if (!input.sessionId || !sessionProviderId) return null;
  const sessionModelId = input.sessionModelId?.trim();
  if (input.receipt && input.receipt.sessionId === input.sessionId) {
    return {
      source: "command-receipt",
      ...noticeTarget(input.receipt.failure, sessionProviderId, sessionModelId),
      key: `command-receipt:${input.sessionId}:${input.receipt.commandId}`,
    };
  }
  // lastError stays in the projection after later turns; only an error phase is current.
  if (input.lastError?.code === PROVIDER_RECONFIGURE_REQUIRED && input.phase === "error") {
    return {
      source: "session-error",
      ...noticeTarget(input.lastError.failure, sessionProviderId, sessionModelId),
      key: `session-error:${input.sessionId}:${input.lastError.at ?? 0}`,
    };
  }
  return null;
}

/** Open Settings → Model Provider focused on this Provider (existing deep-link intent). */
export function openProviderReconfigureSettings(
  providerId: string,
  openSettingsTab: (() => void) | undefined,
  setIntent: typeof setPendingSettingsSectionIntent = setPendingSettingsSectionIntent,
): void {
  setIntent("modelProvider", { modelProviderId: providerId });
  openSettingsTab?.();
}
