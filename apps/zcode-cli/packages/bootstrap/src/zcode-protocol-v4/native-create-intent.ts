import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { nativeCreatePayloadFingerprint } from "@zcode/shared/zcode-protocol-v4/native-create-fingerprint-node";

/** Only validated payload is hashed. Transport IDs/timestamps never enter the immutable intent. */
export function nativeCreateIntent(envelope: CommandEnvelope): {
  workspaceScope: string;
  intentFingerprint: string;
} {
  if (envelope.type !== "createSession") throw new Error("not a create command");
  const payload = envelope.payload as { workspaceId: string };
  return { workspaceScope: payload.workspaceId, intentFingerprint: nativeCreatePayloadFingerprint(envelope.payload) };
}
