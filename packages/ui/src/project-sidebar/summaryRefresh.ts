import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { buildProjectSidebarViewModel } from "./projector.js";
import type { ProjectSidebarTargetViewSnapshot } from "./contract.js";
import { workspaceKey } from "./readModel.js";
import type { TargetServiceSource } from "./targetRefresh.js";

export function refreshProjectSidebarSummaries(params: {
  targetId: string;
  attachmentGeneration: number;
  workspaceIds: readonly string[];
  theme: Theme;
  targetSourcesRef: { current: Map<string, TargetServiceSource> };
  targetViewsRef: { current: Map<string, ProjectSidebarTargetViewSnapshot> };
  targetSummaryGenerationRef: { current: Map<string, number> };
  isCurrentSource(source: TargetServiceSource): boolean;
  enqueueTarget(targetId: string, task: () => Promise<void>): Promise<void>;
  publishCurrentModel(): void;
}): Promise<void> {
  return params.enqueueTarget(params.targetId, async () => {
    const source = params.targetSourcesRef.current.get(params.targetId);
    const currentTarget = params.targetViewsRef.current.get(params.targetId);
    if (
      !source ||
      !currentTarget ||
      source.attachmentGeneration !== params.attachmentGeneration ||
      !params.isCurrentSource(source)
    ) {
      return;
    }
    const agentHost = source.services.agentHostService;
    if (!agentHost) return;
    const generation = (params.targetSummaryGenerationRef.current.get(params.targetId) ?? 0) + 1;
    params.targetSummaryGenerationRef.current.set(params.targetId, generation);
    const workspaces = currentTarget.model.source.worktrees.workspaces.filter((workspace) =>
      params.workspaceIds.includes(workspace.id),
    );
    if (workspaces.length === 0) return;
    const settled = await Promise.allSettled(
      workspaces.map((workspace) =>
        agentHost.listSessionSummaries(workspaceKey(workspace), workspace.worktreePath),
      ),
    );
    if (
      !params.isCurrentSource(source) ||
      params.targetSummaryGenerationRef.current.get(params.targetId) !== generation
    ) {
      return;
    }
    const latest = params.targetViewsRef.current.get(params.targetId);
    if (!latest || latest.attachmentGeneration !== params.attachmentGeneration) return;
    const updatedSummaryFailures = new Map(latest.summaryFailures);
    let summaries = latest.model.source.summaries.filter(
      (summary) =>
        !workspaces.some(
          (workspace) =>
            workspaceKey(workspace) ===
            (summary.spec.execution.workspaceIdentity ?? summary.spec.execution.worktreePath),
        ),
    );
    for (const [index, result] of settled.entries()) {
      const workspace = workspaces[index];
      if (!workspace) continue;
      if (result.status === "fulfilled") {
        updatedSummaryFailures.delete(workspace.id);
        summaries = [...summaries, ...result.value];
      } else {
        const freshness: "offline" | "stale" = isRemoteWorkspaceDisconnectedError(result.reason)
          ? "offline"
          : "stale";
        updatedSummaryFailures.set(workspace.id, freshness);
        const workspaceKeyValue = workspaceKey(workspace);
        summaries = [
          ...summaries,
          ...latest.model.source.summaries
            .filter(
              (summary) =>
                (summary.spec.execution.workspaceIdentity ??
                  summary.spec.execution.worktreePath) === workspaceKeyValue,
            )
            .map((summary) => ({ ...summary, freshness })),
        ];
      }
    }
    const targetModel = buildProjectSidebarViewModel({
      catalog: latest.model.source.catalog,
      worktrees: latest.model.source.worktrees,
      migration: latest.model.source.migration,
      directory: latest.model.source.directory,
      summaries,
      nativeSessionMetadata: latest.model.source.nativeSessionMetadata,
      appearance: resolveTheme(params.theme),
      targetId: params.targetId,
      isLocal: source.kind === "local",
      attachmentGeneration: params.attachmentGeneration,
      remoteSessionId: source.remoteSessionId,
      remoteTarget: source.remoteTarget,
      targetFreshness: latest.model.source.targetFreshness,
      targetWritable: latest.targetWritable,
    });
    params.targetViewsRef.current.set(params.targetId, {
      ...latest,
      model: targetModel,
      summaryFailures: updatedSummaryFailures,
    });
    params.publishCurrentModel();
  });
}
