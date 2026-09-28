import { randomUUID } from "node:crypto";
import { V4_METHODS, commandAckSchema } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolClient } from "../../src/zcode-agent/zcodeProtocolClient.js";
import { nativeClientId } from "./certifyNativeV4Common.js";

type JsonRecord = Record<string, unknown>;

export function objectRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function resultSessionId(value: unknown): string {
  const ack = objectRecord(value);
  const result = objectRecord(ack?.result);
  if (
    ack?.status !== "accepted" ||
    result?.type !== "createSession" ||
    typeof result.sessionId !== "string"
  )
    throw new Error(`native fake session creation was not accepted: ${JSON.stringify(value)}`);
  return result.sessionId;
}

export async function sendNativeCommand(
  client: ZCodeProtocolClient,
  sessionId: string | null,
  type: string,
  payload: unknown,
): Promise<unknown> {
  return client.request(
    V4_METHODS.command,
    {
      commandId: randomUUID(),
      clientId: nativeClientId,
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    },
    commandAckSchema,
  );
}
