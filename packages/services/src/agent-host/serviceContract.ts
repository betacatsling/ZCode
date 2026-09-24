import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  AgentCommand,
  AgentCommandReceipt,
  AgentEvent,
  ExecutionTarget,
  HarnessCatalogEntry,
  HarnessCapabilitiesV2,
  LegacySessionSpec,
  SessionSpecV2,
  StoredAgentSessionSummary,
} from "@zcode/shared/agent-host";
import type { ConversationSnapshot, V4ConversationRowsRangeParams, V4ConversationRowsRangeResult } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

/** Separate target-authoritative channel; native IZCodeAgentService remains unchanged. */
export interface IAgentHostService {
  readonly onEvent: Event<{ spec: SessionSpecV2; event: AgentEvent }>; 
  catalogForTarget(targetId: string): Promise<readonly HarnessCatalogEntry[]>;
  getSessionCapabilities(spec: SessionSpecV2 | LegacySessionSpec): Promise<HarnessCapabilitiesV2>;
  getRuntimeActivity(workspaceId?: string): Promise<{ running: number; waiting: number; uncertain: number }>;
  getSessionSpec(scope: { targetId: string; workspaceId: string; hostSessionId: string }): Promise<SessionSpecV2 | undefined>;
  listWorkspaceSessions(workspaceId: string): Promise<StoredAgentSessionSummary[]>;
  rowsRange(spec: SessionSpecV2 | LegacySessionSpec, request: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult>;
  getAvailability(): Promise<{
    target: ExecutionTarget;
    harnesses: string[];
    admissionEnabled: boolean;
  }>;
  listSessions(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<StoredAgentSessionSummary[]>;
  create(spec: SessionSpecV2, commandId: string): Promise<ConversationSnapshot>;
  queryCreationCommand(commandId: string): Promise<{ spec: SessionSpecV2; receipt: AgentCommandReceipt } | undefined>;
  attach(spec: SessionSpecV2): Promise<ConversationSnapshot>;
  dispatch(spec: SessionSpecV2, command: AgentCommand): Promise<AgentCommandReceipt>;
  snapshot(spec: SessionSpecV2 | LegacySessionSpec): Promise<ConversationSnapshot>;
  eventsSince(spec: SessionSpecV2 | LegacySessionSpec, sequence: number): Promise<readonly AgentEvent[]>;
  queryCommand(spec: SessionSpecV2 | LegacySessionSpec, commandId: string): Promise<AgentCommandReceipt | undefined>;
}

export const IAgentHostService = createServiceDescriptor<IAgentHostService>(
  ServiceChannels.AgentHost,
);
