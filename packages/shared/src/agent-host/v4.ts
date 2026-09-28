import { z } from "zod";
import {
  conversationTopicWireCandidateSchema,
  type ConversationTopicWireCandidate,
  subscribeAckSchema,
  v4ConversationRowsRangeResultSchema,
} from "../zcode-protocol-v4/transport.js";
import { conversationSnapshotSchema } from "../zcode-protocol-v4/snapshot.js";
import { modelBindingRequestSchema, sessionSpecSchema } from "./session-spec.js";

const sessionLocatorIdSchema = z.string().trim().min(1).max(2048);

/** Host-owned identity used to attach an already-created external session. */
export const externalSessionLocatorSchema = z.strictObject({
  targetId: sessionLocatorIdSchema,
  workspaceIdentity: sessionLocatorIdSchema,
  harnessId: sessionLocatorIdSchema,
  hostSessionId: sessionLocatorIdSchema,
});
export type ExternalSessionLocator = z.infer<typeof externalSessionLocatorSchema>;

export function externalSessionLocatorFromSpec(
  spec: z.infer<typeof sessionSpecSchema>,
): ExternalSessionLocator {
  return externalSessionLocatorSchema.parse({
    targetId: spec.execution.targetId,
    workspaceIdentity: spec.execution.workspaceIdentity,
    harnessId: spec.harness.id,
    hostSessionId: spec.hostSessionId,
  });
}

/** Separate from native V4 createSession payload; no external metadata is stuffed into it. */
export const externalSessionCreateRequestSchema = z.strictObject({
  spec: sessionSpecSchema,
});
export type ExternalSessionCreateRequest = z.infer<typeof externalSessionCreateRequestSchema>;

/** Renderer selects a Harness/model and stable IDs; the Host derives target and filesystem location. */
export const externalWorkspaceSessionCreateRequestSchema = z.strictObject({
  workspaceId: sessionSpecSchema.shape.execution.shape.workspaceId.unwrap(),
  worktreeGeneration: sessionSpecSchema.shape.execution.shape.worktreeGeneration.unwrap(),
  hostSessionId: sessionSpecSchema.shape.hostSessionId,
  harness: sessionSpecSchema.shape.harness,
  modelBinding: modelBindingRequestSchema,
});
export type ExternalWorkspaceSessionCreateRequest = z.infer<
  typeof externalWorkspaceSessionCreateRequestSchema
>;

export const externalSessionCreateResultSchema = z.strictObject({
  locator: externalSessionLocatorSchema,
  snapshot: conversationSnapshotSchema,
});
export type ExternalSessionCreateResult = z.infer<typeof externalSessionCreateResultSchema>;

const clientModeSchema = z.enum(["desktop-continuous", "web-remote-replayable"]);
export const agentHostConversationRuntimePolicySchema = z.enum([
  "existing-only",
  "start-if-needed",
]);
export type AgentHostConversationRuntimePolicy = z.infer<
  typeof agentHostConversationRuntimePolicySchema
>;
const baseSchema = z.strictObject({
  logEpoch: z.string().trim().min(1),
  seq: z.number().int().nonnegative(),
});

export const agentHostConversationSubscribeRequestSchema = z.strictObject({
  spec: sessionSpecSchema,
  topic: z.string().trim().min(1).max(2048),
  clientMode: clientModeSchema,
  /** existing-only reads journal history; start-if-needed is an explicit worker admission. */
  runtimePolicy: agentHostConversationRuntimePolicySchema,
  base: baseSchema.optional(),
  visibility: z.enum(["foreground", "background"]).optional(),
});
export type AgentHostConversationSubscribeRequest = z.infer<
  typeof agentHostConversationSubscribeRequestSchema
>;

export const agentHostConversationSubscribeResultSchema = z.strictObject({
  ack: subscribeAckSchema,
});
export type AgentHostConversationSubscribeResult = z.infer<
  typeof agentHostConversationSubscribeResultSchema
>;

export const agentHostConversationResyncRequestSchema = z.strictObject({
  spec: sessionSpecSchema,
  subscriptionId: z.string().trim().min(1).max(1024),
  base: baseSchema.nullable(),
  forceSnapshot: z.boolean().optional(),
});
export type AgentHostConversationResyncRequest = z.infer<
  typeof agentHostConversationResyncRequestSchema
>;

export const agentHostConversationResyncResultSchema = z.strictObject({
  ack: subscribeAckSchema,
});
export type AgentHostConversationResyncResult = z.infer<
  typeof agentHostConversationResyncResultSchema
>;

export const agentHostConversationUnsubscribeRequestSchema = z.strictObject({
  spec: sessionSpecSchema,
  subscriptionId: z.string().trim().min(1).max(1024),
});
export type AgentHostConversationUnsubscribeRequest = z.infer<
  typeof agentHostConversationUnsubscribeRequestSchema
>;

export const agentHostConversationRowsRangeRequestSchema = z.strictObject({
  spec: sessionSpecSchema,
  sessionId: z.string().trim().min(1),
  beforeRowId: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(500),
});
export type AgentHostConversationRowsRangeRequest = z.infer<
  typeof agentHostConversationRowsRangeRequestSchema
>;
export const agentHostConversationRowsRangeResultSchema = v4ConversationRowsRangeResultSchema;
export type AgentHostConversationRowsRangeResult = z.infer<
  typeof agentHostConversationRowsRangeResultSchema
>;

/** Candidate remains permissive until the ownership-filtered V4 assembler validates it. */
export const agentHostConversationFrameSchema = conversationTopicWireCandidateSchema;
export type AgentHostConversationFrame = ConversationTopicWireCandidate;
