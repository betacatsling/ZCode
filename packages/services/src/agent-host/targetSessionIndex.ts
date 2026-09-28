import { realpath } from "node:fs/promises";
import {
  agentHostSessionSummarySchema,
  type AgentHostSessionSummary,
  type ExecutionTarget,
  type SessionSpec,
  type StoredAgentSessionSummary,
} from "@zcode/shared/agent-host";
import { SessionHost } from "./sessionHost.js";

export function createTargetSessionIndex(options: {
  root: string;
  target: ExecutionTarget;
  verify(spec: SessionSpec): Promise<unknown>;
  mounted(): readonly SessionHost[];
}): {
  listSessions(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<StoredAgentSessionSummary[]>;
  listSessionSummaries(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<AgentHostSessionSummary[]>;
} {
  return {
    async listSessions(workspaceIdentity, worktreePath) {
      if (!options.target.available) throw new Error("unauthorized execution target or worktree");
      await realpath(worktreePath);
      const records = await SessionHost.listStoredSessions(options.root, {
        targetId: options.target.id,
        workspaceIdentity,
        worktreePath,
      });
      for (const record of records) await options.verify(record.spec);
      return records;
    },
    async listSessionSummaries(workspaceIdentity, worktreePath) {
      const records = await SessionHost.listStoredSessions(options.root, {
        targetId: options.target.id,
        workspaceIdentity,
        worktreePath,
      });
      const mounted = new Map(
        options
          .mounted()
          .filter(
            (host) =>
              host.spec.execution.workspaceIdentity === workspaceIdentity &&
              host.spec.execution.worktreePath === worktreePath,
          )
          .map((host) => [host.spec.hostSessionId, host.summary()]),
      );
      return records.map((record) => {
        const live = mounted.get(record.spec.hostSessionId);
        if (live) return live;
        return agentHostSessionSummarySchema.parse({
          spec: record.spec,
          title: record.title ?? record.spec.hostSessionId,
          lastKnownStatus: "unknown",
          freshness: options.target.available ? "stale" : "offline",
          recentOutcome: "unknown",
          pendingInteractionCount: 0,
          unread: false,
          updatedAt: Math.floor(record.updatedAt),
          archived: false,
          kind: "top-level",
        });
      });
    },
  };
}
