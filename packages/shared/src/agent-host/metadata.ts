import { z } from "zod";
import { sessionSpecSchema, type SessionSpec } from "./session-spec.js";

/** Manifest lifecycle, not evidence that a backend process or turn is still active. */
export interface StoredAgentSessionSummary {
  spec: SessionSpec;
  state: "creating" | "running" | "terminated";
  title?: string;
  updatedAt: number;
}

export const agentHostSessionLastKnownStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting",
  "cancelling",
  "completed",
  "failed",
  "unknown",
]);
export type AgentHostSessionLastKnownStatus = z.infer<typeof agentHostSessionLastKnownStatusSchema>;

export const agentHostSessionFreshnessSchema = z.enum(["live", "stale", "offline", "unknown"]);
export type AgentHostSessionFreshness = z.infer<typeof agentHostSessionFreshnessSchema>;

export const agentHostSessionRecentOutcomeSchema = z.enum([
  "none",
  "success",
  "failed",
  "cancelled",
  "unknown",
]);
export type AgentHostSessionRecentOutcome = z.infer<typeof agentHostSessionRecentOutcomeSchema>;

/** Bounded Host-owned facts for directory/sidebar rows; never a transcript read. */
export const agentHostSessionSummarySchema = z.strictObject({
  spec: sessionSpecSchema,
  title: z.string().trim().min(1).max(256),
  lastKnownStatus: agentHostSessionLastKnownStatusSchema,
  freshness: agentHostSessionFreshnessSchema,
  recentOutcome: agentHostSessionRecentOutcomeSchema,
  pendingInteractionCount: z.number().int().nonnegative(),
  unread: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  kind: z.enum(["top-level", "terminal", "internal"]),
});
export type AgentHostSessionSummary = z.infer<typeof agentHostSessionSummarySchema>;

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
