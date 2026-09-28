import { useEffect } from "react";
import type { IAgentHostService } from "@zcode/services";
import type { ProjectSidebarViewModel } from "./contract.js";
import { ProjectSidebarSummaryRefreshScheduler } from "./summaryRefreshScheduler.js";

export interface ProjectSidebarSummaryEventTarget {
  readonly targetId: string;
  readonly attachmentGeneration: number;
  readonly agentHostService?: IAgentHostService;
}

export function useProjectSidebarSummaryEvents(params: {
  targets: readonly ProjectSidebarSummaryEventTarget[];
  modelRef: { current: ProjectSidebarViewModel | null };
  refreshSummaries(
    targetId: string,
    attachmentGeneration: number,
    workspaceIds: readonly string[],
  ): Promise<void>;
}): void {
  useEffect(() => {
    const disposables: Array<{ dispose(): void }> = [];
    const schedulers: ProjectSidebarSummaryRefreshScheduler[] = [];
    for (const target of params.targets) {
      const agentHost = target.agentHostService;
      if (!agentHost?.onEvent) continue;
      const scheduler = new ProjectSidebarSummaryRefreshScheduler((workspaceIds) =>
        params.refreshSummaries(target.targetId, target.attachmentGeneration, workspaceIds),
      );
      schedulers.push(scheduler);
      const subscription = agentHost.onEvent(({ spec, event }) => {
        if (event.kind === "text.delta" || event.kind === "usage.reported") return;
        if (spec.execution.targetId !== target.targetId) return;
        const current = params.modelRef.current;
        const currentTarget = current?.source.targets.find(
          (candidate) => candidate.targetId === target.targetId,
        );
        if (currentTarget?.attachmentGeneration !== target.attachmentGeneration) return;
        const record = currentTarget.model.source.migration?.records.find(
          (candidate) =>
            candidate.ownerKind === "agent-host" &&
            candidate.nativeSessionId === event.hostSessionId &&
            candidate.targetId === target.targetId &&
            (candidate.workspaceIdentity ?? candidate.workspacePath) ===
              (spec.execution.workspaceIdentity ?? spec.execution.worktreePath),
        );
        if (record?.workspaceId) scheduler.request([record.workspaceId]);
      });
      disposables.push(subscription);
    }
    return () => {
      for (const disposable of disposables) disposable.dispose();
      for (const scheduler of schedulers) scheduler.dispose();
    };
  }, [params.modelRef, params.refreshSummaries, params.targets]);
}
