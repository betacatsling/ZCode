import type { IAgentHostService } from "../agent-host/serviceContract.js";
import type { CatalogSessionIndex } from "../project-workspaces/sidebarIndexService.js";
import type { TargetWorktreeService } from "../project-workspaces/worktreeService.js";

/** Reads durable Host manifests + read models, not renderer tabs or native task DB. */
export function createExternalSessionIndex(target: TargetWorktreeService, host: IAgentHostService): CatalogSessionIndex {
  return {
    onChange(listener) {
      const subscription = host.onEvent(() => listener());
      return () => subscription.dispose();
    },
    async allSessions() {
      const records = target.records();
      const rows = await Promise.all(records.map((record) => host.listWorkspaceSessions(record.id)));
      const sessions = await Promise.all(rows.flat().filter((row) => row.spec.schemaVersion === 2).map(async (row) => {
        const spec = row.spec;
        if (spec.schemaVersion !== 2) throw new Error("Unexpected legacy Host scope");
        const record = records.find((entry) => entry.id === spec.workspaceId);
        const binding = target.bindings().find((row) => row.id === record?.bindingId);
        if (!record || !binding || binding.projectId !== spec.projectId || spec.execution.targetId !== binding.executionTargetId)
          throw new Error("External session has no trusted target owner");
        const current = record.generation === spec.execution.worktreeGeneration && record.path === spec.execution.worktreePath;
        const model = await host.getSessionReadModel(spec);
        const activity = row.state === "terminated" ? "idle" as const :
          model.activity === "uncertain" ? "unknown" as const : model.activity;
        const online = (await host.getAvailability()).target.available;
        return {
          session: { schemaVersion: 1 as const, id: spec.hostSessionId, projectId: spec.projectId,
            workspaceId: spec.workspaceId, harnessId: spec.harness.id, title: spec.harness.id,
            sortOrder: 0, archived: false },
          updatedAt: Math.max(0, Math.floor(row.updatedAt)), activity,
          freshness: !online ? "offline" as const : current ? "live" as const : "stale" as const,
          ...(model.lastOutcome === "success" ? { lastTurn: "succeeded" as const } : {}),
          ...(model.lastOutcome === "failed" ? { lastTurn: "failed" as const } : {}),
          ...(model.lastOutcome === "cancelled" ? { lastTurn: "cancelled" as const } : {}),
          unread: false,
        };
      }));
      return sessions;
    },
    async workspaceFreshness(workspace) {
      const available = (await host.getAvailability()).target.available;
      return !available ? "offline" : target.history(workspace.id)?.lifecycle === "active" ? "live" : "unknown";
    },
  };
}
