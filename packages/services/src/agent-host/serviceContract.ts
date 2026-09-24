import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { AgentCommand, AgentCommandReceipt, AgentEvent, ExecutionTarget, SessionSpec, StoredAgentSessionSummary } from "@zcode/shared/agent-host";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

/** Separate target-authoritative channel; native IZCodeAgentService remains unchanged. */
export interface IAgentHostService {
  readonly onEvent: Event<{ spec: SessionSpec; event: AgentEvent }>;
  getAvailability(): Promise<{ target: ExecutionTarget; harnesses: string[]; admissionEnabled: boolean }>;
  listSessions(workspaceIdentity: string, worktreePath: string): Promise<StoredAgentSessionSummary[]>;
  create(spec: SessionSpec): Promise<ConversationSnapshot>;
  attach(spec: SessionSpec): Promise<ConversationSnapshot>;
  dispatch(spec: SessionSpec, command: AgentCommand): Promise<AgentCommandReceipt>;
  snapshot(spec: SessionSpec): Promise<ConversationSnapshot>;
  eventsSince(spec: SessionSpec, sequence: number): Promise<readonly AgentEvent[]>;
  queryCommand(spec: SessionSpec, commandId: string): Promise<AgentCommandReceipt | undefined>;
}

export const IAgentHostService = createServiceDescriptor<IAgentHostService>(ServiceChannels.AgentHost);
