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

/** A rejected command receipt remembered by the pane (ids only). */
export interface ProviderReconfigureReceipt {
  sessionId: string;
  commandId: string;
}

/**
 * Pick the rejected send receipt that asks for a Provider reconfigure. V4 CommandAck keeps the
 * reasonCode but not the typed failure, so the Provider comes from the session's own config.
 */
export function providerReconfigureReceiptFromAck(
  ack: { commandId: string; status: string; reasonCode?: string },
  sessionId: string | null,
): ProviderReconfigureReceipt | null {
  if (!sessionId || ack.status !== "rejected" || ack.reasonCode !== PROVIDER_RECONFIGURE_REQUIRED)
    return null;
  return { sessionId, commandId: ack.commandId };
}

/**
 * Resolve the hint from the three places the Host reports it:
 * - capability `credentialAttention` (typed, names the Provider itself);
 * - a rejected command receipt for this session;
 * - the projected session.error (`control.lastError`) while the session is still in error.
 * Receipt and session.error name the session's host-managed Provider (`config.provider`);
 * harness-managed sessions project an empty provider and never get a hint.
 */
export function resolveProviderReconfigureNotice(input: {
  sessionId: string | null;
  phase?: string | null;
  lastError?: { code: string; at?: number } | null;
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
  const providerId = input.sessionProviderId?.trim();
  if (!input.sessionId || !providerId) return null;
  const modelId = input.sessionModelId?.trim();
  const model = modelId ? { modelId } : {};
  if (input.receipt && input.receipt.sessionId === input.sessionId) {
    return {
      source: "command-receipt",
      providerId,
      ...model,
      key: `command-receipt:${input.sessionId}:${input.receipt.commandId}`,
    };
  }
  // lastError stays in the projection after later turns; only an error phase is current.
  if (input.lastError?.code === PROVIDER_RECONFIGURE_REQUIRED && input.phase === "error") {
    return {
      source: "session-error",
      providerId,
      ...model,
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
