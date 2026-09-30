import type { Logger } from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import type { ModelStatusContext } from "./runner-status.js";

type StreamErrorLogContext = Pick<ModelStatusContext, "providerId" | "modelId" | "requestId">;

/**
 * Only ids and the classified status/code. Never the message, response body, headers, URL or
 * request body: upstream errors can echo key material.
 */
export function redactStreamErrorFields(
  error: unknown,
  context: StreamErrorLogContext,
): Record<string, string | number | boolean> {
  const failure = classifyModelFailure(error);
  return {
    providerId: context.providerId,
    modelId: context.modelId,
    requestId: context.requestId,
    ...(failure.statusCode === undefined ? {} : { statusCode: failure.statusCode }),
    code: failure.code,
    reason: failure.reason,
    retryable: failure.retryable,
  };
}

/**
 * Replaces the AI SDK streamText default onError, which console.errors the raw provider error
 * (responseBody, url, requestBodyValues). The error itself still reaches the adapter through the
 * stream and is classified there; this only decides what is logged.
 */
export function createRedactedStreamErrorLogger(
  context: StreamErrorLogContext,
  logger?: Logger,
): (event: { error: unknown }) => void {
  return ({ error }) => {
    const fields = redactStreamErrorFields(error, context);
    if (logger) {
      logger.warn("model stream error", fields);
      return;
    }
    const rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    console.error(`[zcode] model stream error ${rendered}`);
  };
}
