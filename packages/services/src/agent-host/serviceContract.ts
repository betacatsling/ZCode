import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  AgentCommand,
  AgentCommandReceipt,
  AgentEvent,
  AgentHostConversationFrame,
  AgentHostConversationResyncRequest,
  AgentHostConversationResyncResult,
  AgentHostConversationRowsRangeRequest,
  AgentHostConversationRowsRangeResult,
  AgentHostConversationSubscribeRequest,
  AgentHostConversationSubscribeResult,
  AgentHostConversationUnsubscribeRequest,
  AgentHostSessionSummary,
  HarnessDirectorySnapshot,
  StaticHarnessAsset,
  ExecutionTarget,
  ExternalSessionCreateRequest,
  ExternalSessionCreateResult,
  ExternalWorkspaceSessionCreateRequest,
  SessionSpec,
  StoredAgentSessionSummary,
  WorkspaceSessionCreateRequest,
  WorkspaceSessionCreateResult,
  WorkspaceSessionBindingCapabilityRequest,
  WorkspaceSessionBindingCapabilityResult,
  WorkspaceSessionOwnersRequest,
  WorkspaceSessionOwnersResult,
} from "@zcode/shared/agent-host";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";
import type { AgentHostActivityIndex } from "./activityIndex.js";

/** Separate target-authoritative channel; native IZCodeAgentService remains unchanged. */
export interface IAgentHostService {
  readonly onEvent: Event<{ spec: SessionSpec; event: AgentEvent }>;
  readonly onConversationFrame: Event<AgentHostConversationFrame>;
  getAvailability(): Promise<{
    target: ExecutionTarget;
    harnesses: string[];
    admissionEnabled: boolean;
  }>;
  listSessions(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<StoredAgentSessionSummary[]>;
  getDirectory(): Promise<HarnessDirectorySnapshot>;
  /** Host-owned static asset lookup; IDs are allowlisted and never interpreted as paths. */
  getHarnessAsset(assetId: string): Promise<StaticHarnessAsset | null>;
  listSessionSummaries(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<AgentHostSessionSummary[]>;
  /** Complete target-owned execution facts; independent of UI workspace membership. */
  listActivityIndex(): Promise<AgentHostActivityIndex>;
  create(spec: SessionSpec): Promise<ConversationSnapshot>;
  attach(spec: SessionSpec): Promise<ConversationSnapshot>;
  dispatch(spec: SessionSpec, command: AgentCommand): Promise<AgentCommandReceipt>;
  snapshot(spec: SessionSpec): Promise<ConversationSnapshot>;
  eventsSince(spec: SessionSpec, sequence: number): Promise<readonly AgentEvent[]>;
  queryCommand(spec: SessionSpec, commandId: string): Promise<AgentCommandReceipt | undefined>;
  createExternalSession(
    request: ExternalSessionCreateRequest,
  ): Promise<ExternalSessionCreateResult>;
  createExternalForWorkspace(
    request: ExternalWorkspaceSessionCreateRequest,
  ): Promise<ExternalSessionCreateResult>;
  /** Host-scoped explicit creation; no caller-supplied target, path, or owner session ID. */
  createWorkspaceSession(
    request: WorkspaceSessionCreateRequest,
  ): Promise<WorkspaceSessionCreateResult>;
  /** Read-only Host report for one Harness/model binding; this does not create a session. */
  getWorkspaceSessionCapability(
    request: WorkspaceSessionBindingCapabilityRequest,
  ): Promise<WorkspaceSessionBindingCapabilityResult>;
  /** Exact owner facts; includeHistory also reads retained older generations. */
  listWorkspaceSessionOwners(
    request: WorkspaceSessionOwnersRequest,
  ): Promise<WorkspaceSessionOwnersResult>;
  subscribeConversation(
    request: AgentHostConversationSubscribeRequest,
  ): Promise<AgentHostConversationSubscribeResult>;
  resyncConversation(
    request: AgentHostConversationResyncRequest,
  ): Promise<AgentHostConversationResyncResult>;
  unsubscribeConversation(request: AgentHostConversationUnsubscribeRequest): Promise<void>;
  conversationRowsRange(
    request: AgentHostConversationRowsRangeRequest,
  ): Promise<AgentHostConversationRowsRangeResult>;
}

export const IAgentHostService = createServiceDescriptor<IAgentHostService>(
  ServiceChannels.AgentHost,
);

export type {
  AgentHostActivityIndex,
  AgentHostActivityIndexEntry,
  AgentHostActivityState,
} from "./activityIndex.js";
