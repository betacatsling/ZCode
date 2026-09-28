import type { StoredAgentSessionSummary } from "@zcode/shared/agent-host";
import type { ExternalSessionIndexPort, LegacySessionLocator } from "../contract.js";

export interface AgentHostSessionReader {
  listSessions(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<readonly StoredAgentSessionSummary[]>;
}

/** Reads only the Host's persisted manifest index; it never attaches a worker or reads a transcript. */
export function createAgentHostSessionSource(
  reader: AgentHostSessionReader,
): ExternalSessionIndexPort {
  return {
    async listPersistedExternalSessionLocators(workspaces) {
      const locators: LegacySessionLocator[] = [];
      for (const workspace of workspaces) {
        if (workspace.lifecycle !== "active" || workspace.verification !== "verified") continue;
        const identity = workspace.workspaceIdentity?.trim() || workspace.worktreePath;
        const summaries = await reader.listSessions(identity, workspace.worktreePath);
        for (const summary of summaries) {
          const spec = summary.spec;
          const specIdentity = spec.execution.workspaceIdentity;
          if (
            spec.execution.targetId !== workspace.targetId ||
            spec.execution.worktreePath !== workspace.worktreePath ||
            specIdentity !== identity
          )
            continue;
          const modelSelection =
            spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection : undefined;
          locators.push({
            sourceKey: `agent-host:${JSON.stringify([
              spec.execution.targetId,
              specIdentity,
              spec.harness.id,
              spec.hostSessionId,
            ])}`,
            nativeSessionId: spec.hostSessionId,
            ownerKind: "agent-host",
            targetId: spec.execution.targetId,
            workspacePath: spec.execution.worktreePath,
            ...(specIdentity === spec.execution.worktreePath
              ? {}
              : { workspaceIdentity: specIdentity }),
            cwd: spec.execution.worktreePath,
            ...(spec.execution.workspaceId ? { workspaceId: spec.execution.workspaceId } : {}),
            ...(spec.execution.worktreeGeneration
              ? { worktreeGeneration: spec.execution.worktreeGeneration }
              : {}),
            ...(summary.title ? { title: summary.title } : {}),
            harnessId: spec.harness.id,
            modelBindingKind: spec.modelBinding.kind,
            ...(modelSelection ? { modelSelection } : {}),
          });
        }
      }
      return locators;
    },
  };
}
