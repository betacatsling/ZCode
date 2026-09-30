import { useCallback } from "react";
import type { Theme } from "@/useTheme.js";
import type {
  IProjectCatalogService,
  ProjectCatalogReadModel,
} from "@zcode/services/project-catalog";
import type { ProjectSidebarTargetServices } from "@/project-sidebar/contract.js";
import type {
  ProjectSidebarTargetOption,
  ProjectSidebarTargetViewSnapshot,
  ProjectSidebarViewModel,
} from "@/project-sidebar/contract.js";
import type {
  SessionHierarchyRecord,
  WorkspaceSessionCreateRequest,
} from "@zcode/shared/agent-host";
import { projectSidebarSessionViewKey } from "@/project-sidebar/viewKeys.js";
import {
  createProjectSidebarWorkspaceAgent,
  openProjectSidebarHistoryRecord,
  type ProjectSidebarHistoryRoute,
} from "@/project-sidebar/sessionActions.js";
import {
  refreshProjectSidebarTarget,
  type TargetServiceSource,
} from "@/project-sidebar/targetRefresh.js";

export function useProjectSidebarSessionActions(params: {
  theme: Theme;
  profileCatalog: IProjectCatalogService | null;
  targetSourcesRef: { current: Map<string, TargetServiceSource> };
  targetViewsRef: { current: Map<string, ProjectSidebarTargetViewSnapshot> };
  targetObservedAtRef: { current: Map<string, number> };
  modelRef: { current: ProjectSidebarViewModel | null };
  isCurrentSource(source: TargetServiceSource): boolean;
  enqueueTarget<T>(targetId: string, task: () => Promise<T>): Promise<T>;
  resolveCurrentTarget(target: ProjectSidebarTargetOption): TargetServiceSource;
  readProfileCatalog(): Promise<ProjectCatalogReadModel>;
  publishModel(readModel: ProjectCatalogReadModel, status?: "ready" | "refreshing"): void;
}) {
  const getTargetServices = useCallback(
    (targetId: string, attachmentGeneration: number): ProjectSidebarTargetServices | null => {
      const source = params.targetSourcesRef.current.get(targetId);
      if (
        !source ||
        source.attachmentGeneration !== attachmentGeneration ||
        !params.isCurrentSource(source)
      ) {
        return null;
      }
      return {
        agentHostService: source.services.agentHostService ?? null,
        modelSelectionService: source.services.modelSelectionService ?? null,
      };
    },
    [params.isCurrentSource, params.targetSourcesRef],
  );

  const loadHarnessAsset = useCallback(
    async (targetId: string, attachmentGeneration: number, assetId: string) => {
      const services = getTargetServices(targetId, attachmentGeneration);
      if (!services?.agentHostService) return null;
      try {
        return await services.agentHostService.getHarnessAsset(assetId);
      } catch {
        return null;
      }
    },
    [getTargetServices],
  );

  const createWorkspaceAgent = useCallback(
    (
      target: ProjectSidebarTargetOption,
      workspaceId: string,
      worktreeGeneration: string,
      request: Pick<
        WorkspaceSessionCreateRequest,
        "requestId" | "harnessId" | "modelBinding" | "title"
      >,
    ) => {
      const source = params.resolveCurrentTarget(target);
      return params.enqueueTarget(target.targetId, () =>
        createProjectSidebarWorkspaceAgent({
          target,
          workspaceId,
          worktreeGeneration,
          request,
          source,
          isCurrentSource: params.isCurrentSource,
          currentFreshness: (targetId) =>
            params.modelRef.current?.source.targetFreshness.get(targetId),
          currentAction: (hierarchySessionId) =>
            params.modelRef.current?.sessionActions.get(
              projectSidebarSessionViewKey(target.targetId, workspaceId, hierarchySessionId),
            ),
          refreshTarget: async () => {
            if (!params.profileCatalog) throw new Error("project-sidebar-services-unavailable");
            await refreshProjectSidebarTarget({
              profileCatalog: params.profileCatalog,
              source,
              theme: params.theme,
              targetViewsRef: params.targetViewsRef,
              targetObservedAtRef: params.targetObservedAtRef,
              targetSourcesRef: params.targetSourcesRef,
              isCurrentSource: params.isCurrentSource,
              readProfileCatalog: params.readProfileCatalog,
              publishModel: params.publishModel,
            });
          },
        }),
      );
    },
    [
      params.enqueueTarget,
      params.isCurrentSource,
      params.modelRef,
      params.profileCatalog,
      params.publishModel,
      params.readProfileCatalog,
      params.resolveCurrentTarget,
      params.targetObservedAtRef,
      params.targetSourcesRef,
      params.targetViewsRef,
      params.theme,
    ],
  );

  const openHistoryRecord = useCallback(
    (targetId: string, record: SessionHierarchyRecord): Promise<ProjectSidebarHistoryRoute> =>
      openProjectSidebarHistoryRecord({
        targetId,
        record,
        source: params.targetSourcesRef.current.get(targetId),
        isCurrentSource: params.isCurrentSource,
        currentFreshness: (id) => params.modelRef.current?.source.targetFreshness.get(id),
      }),
    [params.isCurrentSource, params.modelRef, params.targetSourcesRef],
  );

  return { getTargetServices, loadHarnessAsset, createWorkspaceAgent, openHistoryRecord };
}
