import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "@/useTheme.js";
import type { CreateWorkspaceRequest, WorktreeCandidate } from "@zcode/services/worktree";
import { resolveTheme } from "@/useTheme.js";
import {
  isWorkspaceServiceAttachmentCurrent,
  useWorkspaceServiceAttachments,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { buildProjectSidebarProfileViewModel } from "@/project-sidebar/profileProjector.js";
import type {
  ProjectSidebarImportResult,
  ProjectSidebarImportSelection,
  ProjectSidebarLoadState,
  ProjectSidebarTargetOption,
  ProjectSidebarTargetViewSnapshot,
  ProjectSidebarViewModel,
  ProjectSidebarWorkspaceBindingOption,
} from "@/project-sidebar/contract.js";
import {
  addProjectAndAdopt as runAddProjectAndAdopt,
  type PendingAdoption,
} from "@/project-sidebar/mutations.js";
import {
  createWorkspace as runCreateWorkspace,
  recoverWorkspaceCreation as runRecoverWorkspaceCreation,
} from "@/project-sidebar/workspaceMutations.js";
import { useProjectSidebarSummaryEvents } from "@/project-sidebar/useProjectSidebarSummaryEvents.js";
import { useProjectSidebarSessionActions } from "@/hooks/useProjectSidebarSessionActions.js";
import { refreshProjectSidebarSummaries } from "@/project-sidebar/summaryRefresh.js";
import {
  sameAttachment,
  targetConnections,
  type TargetServiceSource,
} from "@/project-sidebar/targetRefresh.js";
import { scheduleProjectSidebarTargetRefreshes } from "@/project-sidebar/targetRefreshLifecycle.js";
import { useProjectSidebarViewStore } from "@/store/projectSidebarViewStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

interface UseProjectWorkspaceSidebarInput {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  theme: Theme;
}

export function useProjectWorkspaceSidebar(input: UseProjectWorkspaceSidebarInput) {
  const attachments = useWorkspaceServiceAttachments();
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const profileServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);
  const profileCatalog = profileServices?.projectCatalogService;
  const resolution = useWorkspaceServicesResolution(
    input.workspacePath,
    input.remoteSessionId,
    input.workspaceIdentity,
  );
  const [loadState, setLoadState] = useState<ProjectSidebarLoadState>({ status: "loading" });
  const modelRef = useRef<ProjectSidebarViewModel | null>(null);
  const targetViewsRef = useRef(new Map<string, ProjectSidebarTargetViewSnapshot>());
  const targetSourcesRef = useRef(new Map<string, TargetServiceSource>());
  const targetQueuesRef = useRef(new Map<string, Promise<unknown>>());
  const targetObservedAtRef = useRef(new Map<string, number>());
  const targetSummaryGenerationRef = useRef(new Map<string, number>());
  const pendingAdoptionRef = useRef<PendingAdoption | null>(null);
  const createWorkspaceRequestIdsRef = useRef(new Map<string, string>());
  const profileCatalogRef = useRef(profileCatalog);
  const viewState = useProjectSidebarViewStore((state) => state.resolveLegacyWorkspaceState);

  useEffect(() => {
    if (profileCatalogRef.current === profileCatalog) return;
    profileCatalogRef.current = profileCatalog;
    targetViewsRef.current.clear();
    targetSourcesRef.current.clear();
    modelRef.current = null;
  }, [profileCatalog]);

  const isCurrentSource = useCallback((source: TargetServiceSource): boolean => {
    if (!isWorkspaceServiceAttachmentCurrent(source)) return false;
    const current = targetSourcesRef.current.get(source.targetId);
    return Boolean(current && sameAttachment(current, source));
  }, []);

  const publishModel = useCallback(
    (
      catalogRead: NonNullable<ProjectSidebarViewModel["source"]["catalog"]>,
      status: "ready" | "refreshing" = "ready",
    ) => {
      const targets = [...targetViewsRef.current.values()];
      const model = buildProjectSidebarProfileViewModel({
        catalog: catalogRead,
        targets,
        appearance: resolveTheme(input.theme),
      });
      modelRef.current = model;
      setLoadState({ status, model });
      const scopes = model.snapshot.projects.flatMap((project) =>
        project.workspaces.map((workspace) => ({
          targetId: workspace.targetId,
          workspaceId: workspace.workspaceId,
          sessionIds: workspace.sessions.map((session) => session.sessionId),
        })),
      );
      viewState(scopes);
      return model;
    },
    [input.theme, viewState],
  );

  const readProfileCatalog = useCallback(
    async (sources = targetSourcesRef.current) => {
      if (!profileCatalog) throw new Error("project-sidebar-services-unavailable");
      const catalogFile = await profileCatalog.read();
      return profileCatalog.readWorkspaceCatalog(targetConnections(catalogFile, sources));
    },
    [profileCatalog],
  );

  const enqueueTarget = useCallback(<T,>(targetId: string, task: () => Promise<T>): Promise<T> => {
    const previous = targetQueuesRef.current.get(targetId) ?? Promise.resolve();
    const operation = previous.then(task, task);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    targetQueuesRef.current.set(targetId, tail);
    void tail.finally(() => {
      if (targetQueuesRef.current.get(targetId) === tail) targetQueuesRef.current.delete(targetId);
    });
    return operation;
  }, []);

  const refresh = useCallback(async () => {
    if (!profileCatalog) {
      setLoadState({ status: "unavailable", reason: "project-sidebar-services-unavailable" });
      return;
    }
    setLoadState((current) =>
      current.status === "ready" || current.status === "refreshing"
        ? { status: "refreshing", model: current.model }
        : { status: "loading" },
    );
    try {
      for (const [targetId, source] of targetSourcesRef.current) {
        const stillAttached = attachmentsRef.current.some((attachment) =>
          sameAttachment(attachment, source),
        );
        if (stillAttached && isWorkspaceServiceAttachmentCurrent(source)) continue;
        targetSourcesRef.current.delete(targetId);
        if (
          targetViewsRef.current.get(targetId)?.attachmentGeneration === source.attachmentGeneration
        ) {
          targetViewsRef.current.delete(targetId);
        }
      }
      const catalogFile = await profileCatalog.read();
      const initialRead = await profileCatalog.readWorkspaceCatalog(
        targetConnections(catalogFile, targetSourcesRef.current),
      );
      publishModel(initialRead, "ready");
      if (profileCatalogRef.current !== profileCatalog) return;
      scheduleProjectSidebarTargetRefreshes({
        attachments: attachmentsRef.current,
        activeServices: resolution.services,
        activeRemoteSessionId: resolution.remoteSessionId,
        isRemoteTarget: resolution.isRemoteTarget,
        profileCatalog,
        theme: input.theme,
        targetSourcesRef,
        targetViewsRef,
        targetObservedAtRef,
        isCurrentSource,
        enqueueTarget,
        readProfileCatalog,
        publishModel,
        showLegacyFallback: () =>
          setLoadState({ status: "unavailable", reason: "project-sidebar-unsupported-host" }),
      });
    } catch (error) {
      setLoadState({
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    enqueueTarget,
    isCurrentSource,
    profileCatalog,
    publishModel,
    input.theme,
    resolution.remoteSessionId,
    resolution.isRemoteTarget,
    resolution.services,
    readProfileCatalog,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh, attachments]);

  const publishCurrentModel = useCallback(() => {
    const current = modelRef.current;
    if (!current) return;
    const rebuilt = buildProjectSidebarProfileViewModel({
      catalog: current.source.catalog,
      targets: [...targetViewsRef.current.values()],
      appearance: resolveTheme(input.theme),
    });
    modelRef.current = rebuilt;
    setLoadState({ status: "ready", model: rebuilt });
  }, [input.theme]);

  const refreshTargetSummaries = useCallback(
    (targetId: string, attachmentGeneration: number, workspaceIds: readonly string[]) =>
      refreshProjectSidebarSummaries({
        targetId,
        attachmentGeneration,
        workspaceIds,
        theme: input.theme,
        targetSourcesRef,
        targetViewsRef,
        targetSummaryGenerationRef,
        isCurrentSource,
        enqueueTarget,
        publishCurrentModel,
      }),
    [enqueueTarget, input.theme, isCurrentSource, publishCurrentModel],
  );

  useProjectSidebarSummaryEvents({
    targets: useMemo(
      () =>
        loadState.status === "ready" || loadState.status === "refreshing"
          ? loadState.model.source.targets.map((target) => ({
              targetId: target.targetId,
              attachmentGeneration: target.attachmentGeneration,
              agentHostService: targetSourcesRef.current.get(target.targetId)?.services
                .agentHostService,
            }))
          : [],
      [loadState],
    ),
    modelRef,
    refreshSummaries: refreshTargetSummaries,
  });

  const refreshTargetAfterMutation = useCallback(async (_targetId: string) => refresh(), [refresh]);

  const resolveCurrentTarget = useCallback(
    (
      target: ProjectSidebarTargetOption | ProjectSidebarWorkspaceBindingOption,
    ): TargetServiceSource => {
      const source = targetSourcesRef.current.get(target.targetId);
      if (
        !source ||
        source.attachmentGeneration !== target.attachmentGeneration ||
        source.remoteSessionId !== target.remoteSessionId ||
        !source.available ||
        !isCurrentSource(source)
      ) {
        throw new Error("project-sidebar-stale-candidate");
      }
      return source;
    },
    [isCurrentSource],
  );

  const sessionActions = useProjectSidebarSessionActions({
    theme: input.theme,
    profileCatalog: profileCatalog ?? null,
    targetSourcesRef,
    targetViewsRef,
    targetObservedAtRef,
    modelRef,
    isCurrentSource,
    enqueueTarget,
    resolveCurrentTarget,
    readProfileCatalog,
    publishModel,
  });

  const addProjectAndAdopt = useCallback(
    (
      target: ProjectSidebarTargetOption,
      name: string,
      path: string,
      selection?: ProjectSidebarImportSelection,
      existingProjectId?: string,
    ): Promise<ProjectSidebarImportResult> => {
      const source = resolveCurrentTarget(target);
      return enqueueTarget(target.targetId, () =>
        runAddProjectAndAdopt({
          catalog: profileCatalog,
          worktree: source.services.worktreeService,
          targetId: target.targetId,
          pendingRef: pendingAdoptionRef,
          name,
          worktreePath: path,
          selection,
          existingProjectId,
          isCurrent: () => isCurrentSource(source),
          refresh: () => refreshTargetAfterMutation(target.targetId),
        }),
      );
    },
    [
      enqueueTarget,
      isCurrentSource,
      profileCatalog,
      refreshTargetAfterMutation,
      resolveCurrentTarget,
    ],
  );

  const createWorkspace = useCallback(
    (target: ProjectSidebarWorkspaceBindingOption, request: CreateWorkspaceRequest) => {
      const source = resolveCurrentTarget(target);
      return enqueueTarget(target.targetId, () =>
        runCreateWorkspace({
          catalog: profileCatalog,
          worktree: source.services.worktreeService,
          targetId: target.targetId,
          requestIds: createWorkspaceRequestIdsRef.current,
          request,
          isCurrent: () => isCurrentSource(source),
          refresh: () => refreshTargetAfterMutation(target.targetId),
        }),
      );
    },
    [
      enqueueTarget,
      isCurrentSource,
      profileCatalog,
      refreshTargetAfterMutation,
      resolveCurrentTarget,
    ],
  );

  const recoverWorkspaceCreation = useCallback(
    (
      target: ProjectSidebarWorkspaceBindingOption,
      request: CreateWorkspaceRequest,
      candidate: WorktreeCandidate,
    ) => {
      const source = resolveCurrentTarget(target);
      if (candidate.targetId !== target.targetId)
        throw new Error("project-sidebar-stale-candidate");
      return enqueueTarget(target.targetId, () =>
        runRecoverWorkspaceCreation({
          catalog: profileCatalog,
          worktree: source.services.worktreeService,
          targetId: target.targetId,
          requestIds: createWorkspaceRequestIdsRef.current,
          request,
          candidate,
          isCurrent: () => isCurrentSource(source),
          refresh: () => refreshTargetAfterMutation(target.targetId),
        }),
      );
    },
    [
      enqueueTarget,
      isCurrentSource,
      profileCatalog,
      refreshTargetAfterMutation,
      resolveCurrentTarget,
    ],
  );

  const model =
    loadState.status === "ready" || loadState.status === "refreshing" ? loadState.model : null;
  const targetOptions: readonly ProjectSidebarTargetOption[] = model
    ? model.source.targets.map((target) => ({
        targetId: target.targetId,
        attachmentGeneration: target.attachmentGeneration,
        remoteSessionId: target.remoteSessionId,
        isLocal: target.isLocal,
        targetPresentation: target.targetPresentation,
        writable:
          target.targetWritable && model.source.targetFreshness.get(target.targetId) === "live",
      }))
    : [];

  return {
    loadState,
    targetOptions,
    ...sessionActions,
    refresh,
    addProjectAndAdopt,
    createWorkspace,
    recoverWorkspaceCreation,
  };
}
