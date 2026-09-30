import type { ModelStreamEvent } from "@zcode/contracts";
import type { DecodedMessagesRequest } from "../domain/messagesDecoder.js";
import { messagesUsageIsValid } from "../domain/messagesDecoder.js";
import { ModelGatewayProtocolError } from "../domain/errors.js";
import { MessagesStreamEncoder } from "../domain/messagesStreamEncoder.js";
import { encodeMessagesError, encodeMessagesSse } from "./messagesHttpEncoding.js";
import type { GatewayTokenPort } from "./transport.js";
import type { GatewayGrantRecord } from "./modelResponseStream.js";

export async function* streamGatewayMessagesResponse(input: {
  readonly record: GatewayGrantRecord;
  readonly request: DecodedMessagesRequest;
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
  let encoder: MessagesStreamEncoder | undefined;
  let settled = false;
  let finished = false;
  const settle = (outputTokens: number) => {
    if (settled) return;
    settled = true;
    record.reservedOutputTokens -= reservation;
    record.usedOutputTokens += outputTokens;
  };
  try {
    const events = record.model.streamText({
      messages: request.messages,
      systemInstructions: request.systemInstructions,
      tools: request.tools,
      options: {
        ...record.model.options,
        reasoningLevel: request.effort,
        maxOutputTokens: reservation,
      },
      abortSignal: signal,
    });
    let started = false;
    for await (const event of events) {
      if (signal.aborted) return;
      if (event.type === "start") {
        if (started) continue;
        started = true;
        if (!messagesUsageIsValid(event.usage)) {
          throw new ModelGatewayProtocolError(
            "unsupported_feature",
            "bound Model must report exact input and output usage before streaming",
          );
        }
        encoder = new MessagesStreamEncoder({
          responseId: input.createResponseId(),
          model: record.publicModelId,
          allowedTools: new Set(request.tools.map((tool) => tool.name)),
          maxArgumentBytes: record.limits.maxBodyBytes,
          maxOutputTokens: reservation,
          startUsage: event.usage,
        });
        for (const responseEvent of encoder.start()) yield encodeMessagesSse(responseEvent);
        continue;
      }
      if (!encoder) {
        throw new ModelGatewayProtocolError(
          "unsupported_feature",
          "bound Model must report exact input and output usage before streaming",
        );
      }
      if (event.type === "finish") {
        const outputTokens = event.usage.outputTokens;
        if (!Number.isSafeInteger(outputTokens) || outputTokens === undefined || outputTokens < 0) {
          throw new ModelGatewayProtocolError(
            "unsupported_feature",
            "bound Model did not report exact provider output-token usage",
          );
        }
        if (outputTokens > availableAtAdmission) {
          settle(outputTokens);
          yield encodeMessagesError("Bound Model exceeded the session output-token budget");
          return;
        }
        settle(outputTokens);
        for (const responseEvent of encoder.finish(event)) yield encodeMessagesSse(responseEvent);
        finished = true;
        return;
      }
      for (const responseEvent of encoder.push(event)) yield encodeMessagesSse(responseEvent);
    }
    if (!signal.aborted && !finished)
      yield encodeMessagesError("Bound Model ended without a finish event");
  } catch (error) {
    if (!signal.aborted) {
      const message =
        error instanceof ModelGatewayProtocolError ? error.message : "Bound Model execution failed";
      localAbort.abort();
      yield encodeMessagesError(message);
    }
  } finally {
    if (grantExpiry) clearTimeout(grantExpiry);
    if (!settled) settle(reservation);
    input.onSettled();
  }
}
