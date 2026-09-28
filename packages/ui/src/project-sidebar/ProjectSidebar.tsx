import { useState } from "react";
import {
  BellRingIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import type { SidebarSessionRow, SidebarWorkspaceNode } from "@zcode/shared/agent-host";
import type {
  CreateWorkspaceRequest,
  WorktreeCandidate,
  WorktreeCreateResult,
  WorktreeWorkspaceRecord,
} from "@zcode/services/worktree";
import type {
  ProjectSidebarImportResult,
  ProjectSidebarImportSelection,
  ProjectSidebarTargetOption,
  ProjectSidebarTargetServices,
  ProjectSidebarHarnessAssetLoader,
  ProjectSidebarAgentCreateHandler,
  ProjectSidebarWorkspaceBindingOption,
  ProjectSidebarViewModel,
} from "./contract.js";
import { useProjectSidebarViewStore } from "@/store/projectSidebarViewStore.js";
import { ProjectSidebarAddForm } from "./ProjectSidebarAddForm.js";
import { ProjectSidebarWorkspaceForm } from "./ProjectSidebarWorkspaceForm.js";
import { ProjectSidebarWorkspaceNode } from "./ProjectSidebarWorkspaceNode.js";
import { ProjectSidebarUnverifiedHistory } from "./ProjectSidebarUnverifiedHistory.js";

export function ProjectSidebar({
  model,
  targetOptions,
  getTargetServices,
  loadHarnessAsset,
  appearance,
  onSelectSession,
  onSelectExternalSession,
  onCreateAgent,
  onOpenHistoryRecord,
  onAddProject,
  onCreateWorkspace,
  onRecoverWorkspace,
  onRefresh,
  onReconnectTarget,
}: {
  model: ProjectSidebarViewModel;
  targetOptions: readonly ProjectSidebarTargetOption[];
  getTargetServices: (
    targetId: string,
    attachmentGeneration: number,
  ) => ProjectSidebarTargetServices | null;
  loadHarnessAsset: ProjectSidebarHarnessAssetLoader;
  appearance: "light" | "dark";
  onSelectSession: (workspace: SidebarWorkspaceNode, row: SidebarSessionRow) => void;
  onSelectExternalSession?: (workspace: SidebarWorkspaceNode, row: SidebarSessionRow) => void;
  onCreateAgent: ProjectSidebarAgentCreateHandler;
  onOpenHistoryRecord: (targetId: string, record: import("@zcode/shared/agent-host").SessionHierarchyRecord) => Promise<boolean>;
  onAddProject: (
    target: ProjectSidebarTargetOption,
    name: string,
    path: string,
    selection?: ProjectSidebarImportSelection,
    existingProjectId?: string,
  ) => Promise<ProjectSidebarImportResult>;
  onCreateWorkspace: (
    target: ProjectSidebarWorkspaceBindingOption,
    request: CreateWorkspaceRequest,
  ) => Promise<WorktreeCreateResult>;
  onRecoverWorkspace: (
    target: ProjectSidebarWorkspaceBindingOption,
    request: CreateWorkspaceRequest,
    candidate: WorktreeCandidate,
  ) => Promise<WorktreeWorkspaceRecord>;
  onRefresh: () => Promise<void>;
  onReconnectTarget?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [addOpen, setAddOpen] = useState(false);
  const [workspaceFormProjectId, setWorkspaceFormProjectId] = useState<string | null>(null);
  const projectIds = useProjectSidebarViewStore((state) => state.expandedProjectIds);
  const toggleProject = useProjectSidebarViewStore((state) => state.toggleProject);
  const selectProject = useProjectSidebarViewStore((state) => state.selectProject);
  const revealWorkspace = useProjectSidebarViewStore((state) => state.revealWorkspace);
  const writableTargets = targetOptions.filter((target) => target.writable);
  const canMutateWorktrees = writableTargets.length > 0;
  const offlineTargets = model.source.catalog.targets.filter(
    (target) => model.source.targetFreshness.get(target.targetId) === "offline",
  );
  return (
    <section data-project-sidebar="true" className="shrink-0 border-b border-border px-2 py-2">
      <div className="flex items-center gap-2 px-1 pb-1">
        <span className="min-w-0 flex-1 text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "projectSidebar.title" })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={intl.formatMessage({ id: "projectSidebar.refresh" })}
          onClick={() => void onRefresh()}
          className="min-h-8 min-w-8 text-foreground-subtle"
        >
          <RefreshCwIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={intl.formatMessage({ id: "projectSidebar.addProject" })}
          onClick={() => setAddOpen((open) => !open)}
          disabled={!canMutateWorktrees}
          title={
            canMutateWorktrees
              ? undefined
              : intl.formatMessage({ id: "projectSidebar.createWorkspaceUnavailable" })
          }
          className="min-h-8 min-w-8 text-foreground-subtle"
          data-project-sidebar-add-project="true"
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      {model.staleReason ? (
        <p role="status" className="px-1 pb-1 text-ui-xs text-warning">
          {intl.formatMessage({ id: "projectSidebar.stale" })}
        </p>
      ) : null}
      {!canMutateWorktrees ? (
        <p className="px-1 pb-1 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.createWorkspaceUnavailable" })}
        </p>
      ) : null}
      {offlineTargets.length > 0 ? (
        <div className="space-y-1 px-1 pb-2" role="status">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "projectSidebar.reconnectTargetHint" })}
          </p>
          {offlineTargets.map((target) => (
            <p key={target.targetId} className="truncate text-ui-xs text-foreground-subtlest">
              {target.presentation?.kind === "local"
                ? intl.formatMessage({ id: "projectSidebar.localTarget" })
                : (target.presentation?.displayName ??
                  intl.formatMessage({ id: "projectSidebar.targetNeedsVerification" }))}
            </p>
          ))}
          {onReconnectTarget ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={onReconnectTarget}
              className="min-h-8"
              data-project-sidebar-reconnect-target="true"
            >
              {intl.formatMessage({ id: "projectSidebar.reconnectTarget" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      {addOpen && canMutateWorktrees ? (
        <ProjectSidebarAddForm
          targetOptions={writableTargets}
          projects={model.source.catalog.projects.map((project) => ({
            projectId: project.id,
            name: project.name,
          }))}
          onAddProject={onAddProject}
        />
      ) : null}
      {model.snapshot.projects.length === 0 ? (
        <p className="px-1 pb-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.emptyCatalog" })}
        </p>
      ) : null}
      <div className="max-h-[38vh] space-y-1 overflow-y-auto pr-1">
        {model.snapshot.projects.map((project) => {
          const expanded = projectIds.includes(project.projectId);
          const attentionCount =
            project.summary.pendingInteractionCount + project.summary.errorCount;
          const hasAttention = attentionCount > 0;
          const attentionWorkspace = project.workspaces.find(
            (workspace) =>
              workspace.summary.pendingInteractionCount > 0 || workspace.summary.errorCount > 0,
          );
          return (
            <div key={project.projectId} data-project-sidebar-project={project.projectId}>
              <div className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-ui-base text-foreground">
                <Button
                  type="button"
                  variant="ghost"
                  aria-expanded={expanded}
                  data-project-sidebar-project-toggle={project.projectId}
                  onClick={() => {
                    selectProject(project.projectId);
                    toggleProject(project.projectId);
                  }}
                  className="min-h-8 min-w-0 flex-1 justify-start gap-1.5 px-1 text-left"
                >
                  {expanded ? (
                    <ChevronDownIcon className="size-3.5" />
                  ) : (
                    <ChevronRightIcon className="size-3.5" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                    {project.summary.agentCount}
                  </span>
                  {hasAttention ? (
                    <span className="shrink-0 rounded-sm bg-warning/15 px-1 text-ui-xs text-warning">
                      {attentionCount}
                    </span>
                  ) : null}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  title={intl.formatMessage({ id: "projectSidebar.createWorkspace" })}
                  aria-label={intl.formatMessage(
                    { id: "projectSidebar.createWorkspaceFor" },
                    { project: project.name },
                  )}
                  onClick={() => setWorkspaceFormProjectId(project.projectId)}
                  disabled={!canMutateWorktrees}
                  className="min-h-8 min-w-8 text-foreground-subtlest"
                >
                  <PlusIcon className="size-4" />
                </Button>
              </div>
              {hasAttention && attentionWorkspace ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  onClick={() =>
                    revealWorkspace(
                      project.projectId,
                      attentionWorkspace.targetId,
                      attentionWorkspace.workspaceId,
                    )
                  }
                  aria-label={intl.formatMessage(
                    { id: "projectSidebar.revealAttention" },
                    { count: attentionCount, project: project.name },
                  )}
                  className="ml-5 min-h-8 w-[calc(100%-1.25rem)] justify-start gap-2 px-1 text-left text-ui-sm text-warning"
                  data-project-sidebar-attention={project.projectId}
                >
                  <BellRingIcon className="size-4" />
                  {intl.formatMessage(
                    { id: "projectSidebar.attention" },
                    { count: attentionCount },
                  )}
                </Button>
              ) : null}
              {project.workspaces.length === 0 &&
              model.source.catalog.projects.find((item) => item.id === project.projectId)
                ?.repositoryReferences.length ? (
                <div
                  className="ml-6 space-y-0.5 pb-1"
                  data-project-sidebar-empty-repositories={project.projectId}
                >
                  <p className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "projectSidebar.emptyProjectBindings" })}
                  </p>
                  {model.source.catalog.projects
                    .find((item) => item.id === project.projectId)
                    ?.repositoryReferences.map((reference) => {
                      const presentation = model.source.catalog.targets.find(
                        (target) => target.targetId === reference.targetId,
                      )?.presentation;
                      const targetName =
                        presentation?.kind === "local"
                          ? intl.formatMessage({ id: "projectSidebar.localTarget" })
                          : (presentation?.displayName ??
                            intl.formatMessage({ id: "projectSidebar.targetNeedsVerification" }));
                      return (
                        <p
                          key={`${reference.targetId}\0${reference.repositoryBindingId}`}
                          className="truncate text-ui-xs text-foreground-subtlest"
                        >
                          {targetName} ·{" "}
                          {intl.formatMessage({
                            id: `projectSidebar.freshness.${reference.targetFreshness}`,
                          })}
                        </p>
                      );
                    })}
                </div>
              ) : null}
              {workspaceFormProjectId === project.projectId && canMutateWorktrees ? (
                <ProjectSidebarWorkspaceForm
                  projectId={project.projectId}
                  bindingOptions={model.source.targets
                    .filter(
                      (target) =>
                        target.targetWritable &&
                        model.source.targetFreshness.get(target.targetId) === "live",
                    )
                    .flatMap((target) =>
                      target.model.source.worktrees.bindings
                        .filter((binding) => binding.projectId === project.projectId)
                        .map(
                          (binding): ProjectSidebarWorkspaceBindingOption => ({
                            targetId: target.targetId,
                            attachmentGeneration: target.attachmentGeneration,
                            remoteSessionId: target.remoteSessionId,
                            isLocal: target.isLocal,
                            writable: target.targetWritable,
                            targetPresentation: target.targetPresentation,
                            repositoryBindingId: binding.id,
                            repositoryPath: binding.gitCommonDir,
                          }),
                        ),
                    )}
                  onCreate={onCreateWorkspace}
                  onRecoverWorkspace={onRecoverWorkspace}
                  onCancel={() => setWorkspaceFormProjectId(null)}
                />
              ) : null}
              {expanded ? (
                <div className="space-y-1 pl-2">
                  {project.workspaces.map((workspace) => (
                    <ProjectSidebarWorkspaceNode
                      key={JSON.stringify([workspace.targetId, workspace.workspaceId])}
                      project={project}
                      workspace={workspace}
                      model={model}
                      targetOptions={targetOptions}
                      getTargetServices={getTargetServices}
                      loadHarnessAsset={loadHarnessAsset}
                      appearance={appearance}
                      onCreateAgent={onCreateAgent}
                      onSelectSession={onSelectSession}
                      onSelectExternalSession={onSelectExternalSession}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <ProjectSidebarUnverifiedHistory model={model} onOpenHistoryRecord={onOpenHistoryRecord} />
    </section>
  );
}
