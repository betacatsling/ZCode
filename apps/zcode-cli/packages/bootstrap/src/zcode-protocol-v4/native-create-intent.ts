import { createHash } from "node:crypto";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, part]) => part !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, part]) => [key, canonical(part)]),
    );
  }
  return value;
}

/** Only validated payload is hashed. Transport IDs/timestamps never enter the immutable intent. */
export function nativeCreateIntent(envelope: CommandEnvelope): {
  workspaceScope: string;
  intentFingerprint: string;
} {
  if (envelope.type !== "createSession") throw new Error("not a create command");
  const payload = envelope.payload as { workspaceId: string };
  return {
    workspaceScope: payload.workspaceId,
    intentFingerprint: createHash("sha256")
      .update(JSON.stringify(canonical(envelope.payload)))
      .digest("hex"),
  };
}
