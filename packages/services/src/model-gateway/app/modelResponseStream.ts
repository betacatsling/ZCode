import type { Model } from "@zcode/contracts";
import type { ModelGatewayLimits } from "../contract.js";
import { ModelGatewayProtocolError } from "../domain/errors.js";
import { decodeResponsesRequest } from "../domain/responsesDecoder.js";
import { ResponsesStreamEncoder } from "../domain/responsesStreamEncoder.js";
import { encodeResponsesSse, outputTokenCount } from "./responsesHttpEncoding.js";
import type { GatewayTokenPort } from "./transport.js";

export interface GatewayGrantRecord {
  readonly id: string;
  readonly digest: string;
  readonly sessionId: string;
  readonly protocol: "openai-responses" | "anthropic-messages";
  readonly modelBindingFingerprint: string;
  readonly publicModelId: string;
  readonly model: Model;
  expiresAt: number;
  readonly limits: ModelGatewayLimits;
  readonly revoked: AbortController;
  clientSessionId?: string;
  clientThreadId?: string;
  requestCount: number;
  activeCount: number;
  usedOutputTokens: number;
  reservedOutputTokens: number;
  turnLease?: { readonly turnId: string; expiresAt: number };
}

export async function* streamGatewayModelResponse(input: {
  readonly record: GatewayGrantRecord;
  readonly request: ReturnType<typeof decodeResponsesRequest>;
  readonly reservation: number;
  readonly availableAtAdmission: number;
  readonly clientSignal: AbortSignal;
  readonly now: () => number;
  readonly authorizationExpiry: () => number;
  readonly createResponseId: GatewayTokenPort["createResponseId"];
  readonly onSettled: () => void;
}): AsyncGenerator<Uint8Array> {
  const { record, request, reservation, availableAtAdmission } = input;
  const localAbort = new AbortController();
  const expired = new AbortController();
  const signal = AbortSignal.any([
    input.clientSignal,
    record.revoked.signal,
    localAbort.signal,
    expired.signal,
  ]);
  let grantExpiry: ReturnType<typeof setTimeout> | undefined;
  const checkGrantExpiry = () => {
    const remaining = input.authorizationExpiry() - input.now();
    if (remaining <= 0) expired.abort();
    else {
      grantExpiry = setTimeout(checkGrantExpiry, remaining);
      grantExpiry.unref();
    }
  };
  checkGrantExpiry();
  const encoder = new ResponsesStreamEncoder({
    responseId: input.createResponseId(),
    model: record.publicModelId,
    allowedTools: new Set(request.tools.map((tool) => tool.name)),
    parallelToolCalls: request.parallelToolCalls,
    createdAt: Math.floor(input.now() / 1000),
    maxToolArgumentBytes: record.limits.maxBodyBytes,
    instructions: request.systemInstructions,
    maxOutputTokens: reservation,
  });
  let settled = false;
  let finished = false;
  const settle = (outputTokens: number) => {
    if (settled) return;
    settled = true;
    record.reservedOutputTokens -= reservation;
    record.usedOutputTokens += outputTokens;
  };
  try {
    if (signal.aborted) return;
    for (const event of encoder.start()) yield encodeResponsesSse(event);
    if (signal.aborted) return;
    const modelRequest = {
      messages: request.messages,
      systemInstructions: request.systemInstructions,
      tools: request.tools,
      options: { ...record.model.options, maxOutputTokens: reservation },
      abortSignal: signal,
    };
    for await (const event of record.model.streamText(modelRequest)) {
      if (signal.aborted) return;
      if (event.type === "finish") {
        const outputTokens = outputTokenCount(event.usage);
        if (outputTokens !== undefined && outputTokens > availableAtAdmission) {
          settle(outputTokens);
          yield encodeResponsesSse(
            firstEvent(
              encoder.error(
                "budget_exceeded",
                "Bound model exceeded the session output-token budget",
              ),
            ),
          );
          return;
        }
        settle(outputTokens ?? reservation);
        finished = true;
        for (const outputEvent of encoder.finish(event)) yield encodeResponsesSse(outputEvent);
        return;
      }
      try {
        for (const outputEvent of encoder.push(event)) yield encodeResponsesSse(outputEvent);
      } catch (error) {
        localAbort.abort();
        if (error instanceof ModelGatewayProtocolError) {
          yield encodeResponsesSse(firstEvent(encoder.error(error.code, error.message)));
        } else {
          yield encodeResponsesSse(
            firstEvent(encoder.error("model_error", "Model output could not be encoded")),
          );
        }
        return;
      }
    }
    if (!signal.aborted && !finished)
      yield encodeResponsesSse(
        firstEvent(encoder.error("model_error", "Bound model ended without a finish event")),
      );
  } catch {
    if (!signal.aborted)
      yield encodeResponsesSse(
        firstEvent(encoder.error("model_error", "Bound model execution failed")),
      );
  } finally {
    if (grantExpiry) clearTimeout(grantExpiry);
    if (!settled) settle(reservation);
    input.onSettled();
  }
}

function firstEvent<T>(events: readonly T[]): T {
  const event = events[0];
  if (event === undefined)
    throw new Error("Model Gateway encoder omitted a required terminal event");
  return event;
}
