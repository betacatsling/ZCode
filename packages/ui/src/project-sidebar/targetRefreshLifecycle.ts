import type { Theme } from "@/useTheme.js";
import type { IServiceAccessor } from "@zcode/services";
import type {
  IProjectCatalogService,
  ProjectCatalogReadModel,
} from "@zcode/services/project-catalog";
import {
  isWorkspaceServiceAttachmentCurrent,
  type WorkspaceServiceAttachment,
} from "@/hooks/useWorkspaceServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import type { ProjectSidebarTargetViewSnapshot } from "./contract.js";
import {
  catalogObservedAt,
  isUnsupportedSidebarTargetError,
  refreshProjectSidebarTarget,
  sameAttachment,
  targetPresentationForAttachment,
  type TargetServiceSource,
} from "./targetRefresh.js";

export function scheduleProjectSidebarTargetRefreshes(params: {
  attachments: readonly WorkspaceServiceAttachment[];
  activeServices: IServiceAccessor;
  activeRemoteSessionId: string | null;
  isRemoteTarget: boolean;
  profileCatalog: IProjectCatalogService;
  theme: Theme;
  targetSourcesRef: { current: Map<string, TargetServiceSource> };
  targetViewsRef: { current: Map<string, ProjectSidebarTargetViewSnapshot> };
  targetObservedAtRef: { current: Map<string, number> };
  isCurrentSource(source: TargetServiceSource): boolean;
  enqueueTarget(targetId: string, task: () => Promise<void>): Promise<unknown>;
  readProfileCatalog(): Promise<ProjectCatalogReadModel>;
  publishModel(readModel: ProjectCatalogReadModel, status?: "ready" | "refreshing"): void;
  showLegacyFallback(): void;
}): void {
  const isActiveAttachment = (attachment: WorkspaceServiceAttachment) =>
    attachment.services === params.activeServices ||
    attachment.remoteSessionId === params.activeRemoteSessionId;

  const removeActiveTargetViews = (attachment: WorkspaceServiceAttachment) => {
    const removedTargetIds: string[] = [];
    for (const [targetId, target] of params.targetViewsRef.current) {
      const matches = params.isRemoteTarget
        ? target.remoteSessionId === attachment.remoteSessionId
        : target.isLocal && attachment.kind === "local";
      if (matches) {
        removedTargetIds.push(targetId);
        params.targetViewsRef.current.delete(targetId);
      }
    }
    for (const targetId of removedTargetIds) params.targetSourcesRef.current.delete(targetId);
  };

  const publishFailure = async (source: TargetServiceSource, error: unknown) => {
    if (!params.isCurrentSource(source)) return;
    const freshness = isRemoteWorkspaceDisconnectedError(error) ? "offline" : "stale";
    const catalogFile = await params.profileCatalog.read();
    const observedAt = catalogObservedAt(
      catalogFile,
      source.targetId,
      params.targetObservedAtRef.current.get(source.targetId) ?? 0,
    );
    params.targetObservedAtRef.current.set(source.targetId, observedAt);
    await params.profileCatalog.markTargetFreshness(source.targetId, freshness, observedAt);
    if (!params.isCurrentSource(source)) return;
    const unsupported = isUnsupportedSidebarTargetError(error);
    const active = isActiveAttachment(source);
    if (unsupported && active) {
      params.targetSourcesRef.current.delete(source.targetId);
      params.targetViewsRef.current.delete(source.targetId);
    } else if (freshness === "offline") {
      params.targetSourcesRef.current.set(source.targetId, {
        ...source,
        available: false,
        writable: false,
      });
    }
    params.publishModel(await params.readProfileCatalog());
    if (unsupported && active && params.targetViewsRef.current.size === 0) {
      params.showLegacyFallback();
    }
  };

  for (const attachment of params.attachments) {
    void (async () => {
      let source: TargetServiceSource | undefined;
      try {
        if (!isWorkspaceServiceAttachmentCurrent(attachment)) return;
        const worktree = attachment.services.worktreeService;
        if (!worktree) throw new Error("project-sidebar-worktree-service-unavailable");
        const availability = await worktree.getAvailability();
        if (!isWorkspaceServiceAttachmentCurrent(attachment)) return;
        source = {
          ...attachment,
          targetId: availability.targetId,
          available: availability.available,
          writable: availability.writable,
          targetPresentation: targetPresentationForAttachment(
            attachment.kind,
            attachment.remoteTarget,
          ),
        };
        for (const [previousTargetId, previous] of params.targetSourcesRef.current) {
          if (sameAttachment(previous, attachment) && previousTargetId !== source.targetId) {
            params.targetSourcesRef.current.delete(previousTargetId);
            params.targetViewsRef.current.delete(previousTargetId);
          }
        }
        const current = params.targetSourcesRef.current.get(source.targetId);
        if (
          current &&
          (current.attachmentGeneration > source.attachmentGeneration ||
            (!sameAttachment(current, source) && current.available && !source.available))
        ) {
          return;
        }
        params.targetSourcesRef.current.set(source.targetId, source);
        if (
          params.targetViewsRef.current.get(source.targetId)?.attachmentGeneration !==
          source.attachmentGeneration
        ) {
          params.targetViewsRef.current.delete(source.targetId);
        }
        void params.enqueueTarget(source.targetId, async () => {
          try {
            await refreshProjectSidebarTarget({
              profileCatalog: params.profileCatalog,
              source: source!,
              theme: params.theme,
              targetViewsRef: params.targetViewsRef,
              targetObservedAtRef: params.targetObservedAtRef,
              targetSourcesRef: params.targetSourcesRef,
              isCurrentSource: params.isCurrentSource,
              readProfileCatalog: params.readProfileCatalog,
              publishModel: params.publishModel,
            });
          } catch (error) {
            await publishFailure(source!, error);
          }
        });
      } catch (error) {
        if (!isWorkspaceServiceAttachmentCurrent(attachment)) return;
        if (source) {
          await publishFailure(source, error);
          return;
        }
        const knownSource = [...params.targetSourcesRef.current.values()].find((candidate) =>
          sameAttachment(candidate, attachment),
        );
        if (knownSource) {
          await params.enqueueTarget(knownSource.targetId, async () => {
            await publishFailure(knownSource, error);
          });
          return;
        }
        if (isActiveAttachment(attachment) && isUnsupportedSidebarTargetError(error)) {
          removeActiveTargetViews(attachment);
          if (params.targetViewsRef.current.size === 0) params.showLegacyFallback();
          else params.publishModel(await params.readProfileCatalog());
        }
      }
    })();
  }
}
