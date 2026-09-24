import { z } from "zod";
import type { SessionSpec } from "./session-spec.js";

/** Manifest lifecycle, not evidence that a backend process or turn is still active. */
export interface StoredAgentSessionSummary {
  spec: SessionSpec;
  state: "creating" | "running" | "terminated";
  updatedAt: number;
}


/** Native sessions omit this sidecar; missing is interpreted as zcode, not "glm" for external data. */
export const agentHostSessionMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  harnessId: z.string().trim().min(1),
  targetId: z.string().trim().min(1),
  hostSessionId: z.string().trim().min(1),
  modelBindingKind: z.enum(["host-managed", "harness-managed"]),
});
export type AgentHostSessionMetadata = z.infer<typeof agentHostSessionMetadataSchema>;

export function resolveSessionHarness(metadata?: AgentHostSessionMetadata): string {
  return metadata?.harnessId ?? "zcode";
}
