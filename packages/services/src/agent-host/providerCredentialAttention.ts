import { createHash } from "node:crypto";
import type { Model } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import type { AgentModelFailure } from "@zcode/shared/agent-host";

/** Admission refusal for a Provider whose credential was rejected; key-free by construction. */
export interface ProviderCredentialAttentionNotice {
  readonly message: string;
  readonly failure: AgentModelFailure;
}

interface AttentionMark {
  /** Hash of the credential-relevant config the rejected request used; never the key itself. */
  readonly credential: string;
  readonly reason: string;
  readonly statusCode?: number;
}

/**
 * Hash of what a reconfigure changes: access (key/account kind), api (endpoint/type) and, for
 * account access, the account source revision (re-login). Model lists are excluded.
 */
export function providerCredentialFingerprint(
  config: RegistryProviderConfig,
  accountRevision: string,
): string {
  const { access, api } = config.toJSON();
  const account = config.access.type === "zhipu-account" ? accountRevision : null;
  return createHash("sha256")
    .update(JSON.stringify([access ?? null, api ?? null, account]))
    .digest("hex");
}

/**
 * In-memory "credential needs attention" state per Provider. Set only when a host-bound Model
 * request is rejected with HTTP 401 (non-retryable auth_failed), or fails locally with
 * provider_not_configured before any request; a 403 (permission/region) never marks;
 * cleared automatically once the Provider's credential fingerprint changes (reconfigure) or the
 * Provider disappears. Lives as long as the Registry catalog of one Host process.
 */
export class ProviderCredentialAttention {
  readonly #marks = new Map<string, AttentionMark>();

  /** Wraps a bound Model so its rejected-credential failures mark the Provider. */
  observe(model: Model, credential: string): Model {
    const note = (error: unknown) => this.#record(model.providerId, credential, error);
    return {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      properties: model.properties,
      optionSpecs: model.optionSpecs,
      options: model.options,
      bind: (options) => this.observe(model.bind(options), credential),
      generateText: async (request) => {
        try {
          return await model.generateText(request);
        } catch (error) {
          note(error);
          throw error;
        }
      },
      streamText: (request) => {
        try {
          return observeStream(model.streamText(request), note);
        } catch (error) {
          note(error);
          throw error;
        }
      },
    };
  }

  /** Returns the refusal while the Provider's current credential is the rejected one. */
  check(
    providerId: string,
    modelId: string,
    credential: string | undefined,
  ): ProviderCredentialAttentionNotice | undefined {
    const mark = this.#marks.get(providerId);
    if (!mark) return undefined;
    if (mark.credential !== credential) {
      this.#marks.delete(providerId);
      return undefined;
    }
    const failure: AgentModelFailure = {
      reason: mark.reason,
      action: "reconfigure-provider",
      providerId,
      modelId,
      ...(mark.statusCode === undefined ? {} : { statusCode: mark.statusCode }),
      retryable: false,
    };
    const status = mark.statusCode === undefined ? "" : ` (HTTP ${mark.statusCode})`;
    return {
      failure,
      message:
        `Provider ${providerId} credentials need attention: its last request was rejected${status}: ${mark.reason}. Reconfigure this Provider or explicitly choose another model; no request was sent.`.slice(
          0,
          1024,
        ),
    };
  }

  #record(providerId: string, credential: string, error: unknown): void {
    if (!(error instanceof Error)) return;
    const { context } = error as { context?: unknown };
    if (!context || typeof context !== "object") return;
    const { reason, statusCode, retryable } = context as Record<string, unknown>;
    if (retryable === true) return;
    // Only a rejected credential (401) or a locally missing one is fixed by a new key; 403 may be
    // permission/region and stays a per-turn typed failure without blocking admission.
    if (reason === "auth_failed" && statusCode === 401) {
      this.#marks.set(providerId, { credential, reason, statusCode });
    } else if (reason === "provider_not_configured" && statusCode === undefined) {
      this.#marks.set(providerId, { credential, reason });
    }
  }
}

async function* observeStream<T>(
  stream: AsyncIterable<T>,
  note: (error: unknown) => void,
): AsyncGenerator<T> {
  try {
    yield* stream;
  } catch (error) {
    note(error);
    throw error;
  }
}
