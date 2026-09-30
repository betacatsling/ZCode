import type { AgentModelFailure } from "@zcode/shared/agent-host";

/**
 * Harness-neutral classification of a failed host-bound Model request. Any harness adapter
 * (Pi today; Claude/Codex later) can use it to turn the executor's typed error into key-free facts
 * and, for credential/configuration failures, the typed `provider-reconfigure-required` cause.
 * Pure and dependency-free (type imports only), so it is safe inside worker bundles.
 */

/** Identity of the admitted turn Model; the error itself is never trusted for identity. */
export interface ModelFailureIdentity {
  readonly providerId: string;
  readonly modelId: string;
}

/** Key-free facts about a failed Model request (same shape as the Pi protocol's PiModelFailure). */
export interface ModelFailureFacts {
  reason: string;
  code?: string;
  providerId: string;
  modelId: string;
  statusCode?: number;
  retryable: boolean;
}

const SAFE_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Copies only whitelisted scalar fields from the executor's typed error (AiSdkModelAdapterError
 * code + runner context). Messages, causes, headers and URLs never cross into the worker.
 * Provider/model identity comes from the admitted turn Model, not from the error.
 */
export function extractModelFailure(
  error: unknown,
  model: ModelFailureIdentity,
): ModelFailureFacts | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, context } = error as { code?: unknown; context?: unknown };
  if (!context || typeof context !== "object") return undefined;
  const { reason, statusCode, retryable } = context as Record<string, unknown>;
  if (typeof reason !== "string" || !SAFE_TOKEN.test(reason)) return undefined;
  return {
    reason,
    ...(typeof code === "string" && SAFE_TOKEN.test(code) ? { code } : {}),
    providerId: model.providerId,
    modelId: model.modelId,
    ...(typeof statusCode === "number" && Number.isInteger(statusCode) ? { statusCode } : {}),
    retryable: retryable === true,
  };
}

/**
 * Credential/configuration failures the user must fix (never retried or rerouted to another
 * model): non-retryable `auth_failed` (the adapter uses it for 401 and 403) or
 * `provider_not_configured` (as reason or code). Same rule the Pi worker applies to the turn's
 * session.error. The Host credential-attention mark that blocks admission is narrower (401 or
 * local provider_not_configured only) and lives in ProviderCredentialAttention.
 */
export function toProviderReconfigureFailure(
  facts: (Omit<ModelFailureFacts, "modelId"> & { modelId?: string }) | undefined,
): AgentModelFailure | undefined {
  if (
    !facts ||
    facts.retryable ||
    (facts.reason !== "auth_failed" &&
      facts.reason !== "provider_not_configured" &&
      facts.code !== "provider_not_configured")
  )
    return undefined;
  return {
    reason: facts.reason,
    action: "reconfigure-provider",
    providerId: facts.providerId,
    ...(facts.modelId === undefined ? {} : { modelId: facts.modelId }),
    ...(facts.statusCode === undefined ? {} : { statusCode: facts.statusCode }),
    retryable: false,
  };
}

/** {@link extractModelFailure} then {@link toProviderReconfigureFailure}. */
export function classifyProviderReconfigureFailure(
  error: unknown,
  model: ModelFailureIdentity,
): AgentModelFailure | undefined {
  return toProviderReconfigureFailure(extractModelFailure(error, model));
}
