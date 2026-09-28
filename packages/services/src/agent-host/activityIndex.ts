import type { SessionSpec } from "@zcode/shared/agent-host";

export type AgentHostActivityState = "idle" | "busy" | "unknown";

export interface AgentHostActivityIndexEntry {
  spec: SessionSpec;
  runtimeEpoch: string | null;
  sequence: number;
  state: AgentHostActivityState;
  activeTurnId: string | null;
  pendingInteractionIds: readonly string[];
}

/** Target-owned bounded projection. It never includes transcript rows or commands. */
export interface AgentHostActivityIndex {
  targetId: string;
  complete: boolean;
  sessions: readonly AgentHostActivityIndexEntry[];
}
