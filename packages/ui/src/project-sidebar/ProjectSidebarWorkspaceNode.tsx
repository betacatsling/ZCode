import { ChevronDownIcon, ChevronRightIcon, EyeOffIcon, PlusIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import type {
  HarnessManifest,
  SidebarProjectNode,
  SidebarSessionRow,
  SidebarWorkspaceNode,
} from "@zcode/shared/agent-host";
import { useProjectSidebarViewStore } from "@/store/projectSidebarViewStore.js";
import type { ProjectSidebarViewModel } from "./contract.js";
import {
  type ProjectSidebarAgentCreateHandler,
  type ProjectSidebarHarnessAssetLoader,
  type ProjectSidebarTargetOption,
  type ProjectSidebarTargetServices,
} from "./contract.js";
import { HarnessIcon, type HarnessAssetLoader } from "@/harness/HarnessIcon.js";
import { ProjectSidebarAgentCreateForm } from "./ProjectSidebarAgentCreateForm.js";
import { SessionStatusIcon } from "./SessionStatusIcon.js";
import { cn } from "@/components/lib/utils.js";
import { projectSidebarSessionViewKey, projectSidebarWorkspaceViewKey } from "./viewKeys.js";
import { useCallback, useState } from "react";

function HeadLabel({ workspace }: { workspace: SidebarWorkspaceNode }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="truncate text-ui-xs text-foreground-subtlest">
      {workspace.head?.kind === "branch"
        ? workspace.head.ref
        : workspace.head?.kind === "detached"
          ? `${intl.formatMessage({ id: "projectSidebar.detachedHead" })} ${workspace.head.oid.slice(0, 8)}`
          : intl.formatMessage({ id: "projectSidebar.needsVerification" })}
    </span>
  );
}

function SessionRow({
  row,
  selectable,
  reason,
  onSelect,
  dataOwnerKind,
  dataOwnerLocatorAvailable,
  targetId,
  manifest,
  appearance,
  loadAsset,
}: {
  row: SidebarSessionRow;
  selectable: boolean;
  reason: string;
  onSelect: () => void;
  dataOwnerKind?: "native-v4" | "agent-host";
  dataOwnerLocatorAvailable?: boolean;
  targetId: string | null;
  manifest?: HarnessManifest;
  appearance: "light" | "dark";
  loadAsset?: HarnessAssetLoader;
}) {
  const { intl, locale } = useZCodeIntl();
  const updatedAt = row.updatedAt > 0 ? new Date(row.updatedAt) : null;
  const updateText = updatedAt
    ? intl.formatMessage(
        { id: "projectSidebar.updatedAt" },
        {
          time: new Intl.DateTimeFormat(locale, {
            dateStyle: "short",
            timeStyle: "short",
          }).format(updatedAt),
        },
      )
    : null;
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={!selectable}
      title={selectable ? (updateText ? `${row.title} · ${updateText}` : row.title) : reason}
      aria-label={selectable ? row.title : `${row.title}: ${reason}`}
      onClick={onSelect}
      data-project-sidebar-session={row.sessionId}
      data-project-sidebar-owner-kind={dataOwnerKind}
      data-project-sidebar-owner-locator-available={
        dataOwnerLocatorAvailable === undefined ? undefined : String(dataOwnerLocatorAvailable)
      }
      data-project-sidebar-target={targetId ?? "legacy"}
      className={cn(
        "min-h-8 w-full justify-start gap-2 rounded-md px-2 text-left text-ui-sm",
        selectable ? "text-foreground" : "cursor-not-allowed text-foreground-subtlest",
      )}
    >
      <SessionStatusIcon row={row} />
      <HarnessIcon
        manifest={manifest}
        label={manifest?.name ?? row.harnessName}
        appearance={appearance}
        className="size-4"
        loadAsset={loadAsset}
      />
      <span className="min-w-0 flex-1 truncate" data-harness-name={manifest?.name ?? row.harnessName}>
        {row.title}
      </span>
      {updateText ? (
        <time
          dateTime={updatedAt?.toISOString()}
          title={updateText}
          className="shrink-0 text-ui-xs text-foreground-subtlest"
        >
          {new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(updatedAt!)}
        </time>
      ) : null}
      {row.unread ? (
        <span
          aria-label={intl.formatMessage({ id: "projectSidebar.unread" })}
          className="size-1.5 rounded-full bg-brand"
        />
      ) : null}
    </Button>
  );
}

export function ProjectSidebarWorkspaceNode({
  project,
  workspace,
  model,
  targetOptions,
  getTargetServices,
  loadHarnessAsset,
  appearance,
  onCreateAgent,
  onSelectSession,
  onSelectExternalSession,
}: {
  project: SidebarProjectNode;
  workspace: SidebarWorkspaceNode;
  model: ProjectSidebarViewModel;
  targetOptions: readonly ProjectSidebarTargetOption[];
  getTargetServices: (
    targetId: string,
    attachmentGeneration: number,
  ) => ProjectSidebarTargetServices | null;
  loadHarnessAsset: ProjectSidebarHarnessAssetLoader;
  appearance: "light" | "dark";
  onCreateAgent: ProjectSidebarAgentCreateHandler;
  onSelectSession: (workspace: SidebarWorkspaceNode, row: SidebarSessionRow) => void;
  onSelectExternalSession?: (workspace: SidebarWorkspaceNode, row: SidebarSessionRow) => void;
}) {
  const { intl } = useZCodeIntl();
  const displayTitle =
    workspace.worktreePath === null &&
    workspace.verification === "needsVerification" &&
    workspace.title === "Needs verification"
      ? intl.formatMessage({ id: "projectSidebar.needsVerification" })
      : workspace.title;
  const expanded = useProjectSidebarViewStore((state) =>
    state.expandedWorkspaceKeys.includes(
      projectSidebarWorkspaceViewKey(workspace.targetId, workspace.workspaceId),
    ),
  );
  const hidden = useProjectSidebarViewStore((state) =>
    state.hiddenWorkspaceKeys.includes(
      projectSidebarWorkspaceViewKey(workspace.targetId, workspace.workspaceId),
    ),
  );
  const toggleWorkspace = useProjectSidebarViewStore((state) => state.toggleWorkspace);
  const selectWorkspace = useProjectSidebarViewStore((state) => state.selectWorkspace);
  const selectSession = useProjectSidebarViewStore((state) => state.selectSession);
  const hideWorkspace = useProjectSidebarViewStore((state) => state.hideWorkspace);
  const revealWorkspace = useProjectSidebarViewStore((state) => state.revealWorkspace);
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const targetOption = targetOptions.find((target) => target.targetId === workspace.targetId);
  const targetServices =
    targetOption && workspace.targetId !== null
      ? getTargetServices(workspace.targetId, targetOption.attachmentGeneration)
      : null;
  const targetView = model.source.targets.find((target) => target.targetId === workspace.targetId);
  const targetWorkspace = targetView?.model.source.worktrees.workspaces.find(
    (item) => item.id === workspace.workspaceId,
  );
  const targetLabel =
    targetOption?.targetPresentation.kind === "local"
      ? intl.formatMessage({ id: "projectSidebar.localTarget" })
      : (targetOption?.targetPresentation.displayName ??
        intl.formatMessage({ id: "projectSidebar.targetNeedsVerification" }));
  const loadAsset = useCallback(
    (assetId: string) =>
      workspace.targetId !== null && targetOption
        ? loadHarnessAsset(workspace.targetId, targetOption.attachmentGeneration, assetId)
        : Promise.resolve(null),
    [loadHarnessAsset, targetOption, workspace.targetId],
  );
  const canOpenAgentForm = Boolean(
    targetOption?.writable &&
      workspace.targetFreshness === "live" &&
      workspace.worktreePath !== null &&
      workspace.verification === "verified" &&
      workspace.lifecycle === "active" &&
      targetWorkspace?.worktreeGeneration,
  );
  const hasAttention =
    workspace.summary.pendingInteractionCount > 0 || workspace.summary.errorCount > 0;
  if (hidden) {
    return hasAttention ? (
      <Button
        type="button"
        variant="ghost"
        size="lg"
        onClick={() =>
          revealWorkspace(project.projectId, workspace.targetId, workspace.workspaceId)
        }
        aria-label={intl.formatMessage(
          { id: "projectSidebar.showWorkspace" },
          { workspace: displayTitle },
        )}
        className="min-h-8 w-full justify-start gap-2 text-left text-warning"
        data-project-sidebar-hidden-workspace={workspace.workspaceId}
        data-project-sidebar-target={workspace.targetId ?? "legacy"}
      >
        <EyeOffIcon className="size-4" />
        <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
        <span className="shrink-0 text-ui-xs">
          {workspace.summary.pendingInteractionCount + workspace.summary.errorCount}
        </span>
      </Button>
    ) : null;
  }
  return (
    <div
      data-project-sidebar-workspace={workspace.workspaceId}
      data-project-sidebar-target={workspace.targetId ?? "legacy"}
      className="rounded-md"
    >
      <div className="group flex items-center gap-1 rounded-md px-1 hover:bg-hover">
        <Button
          type="button"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => {
            selectWorkspace(project.projectId, workspace.targetId, workspace.workspaceId);
            toggleWorkspace(workspace.targetId, workspace.workspaceId);
          }}
          className="min-h-8 min-w-0 flex-1 justify-start gap-1.5 px-1 text-left text-ui-sm text-foreground"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
          <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
          {workspace.isMainWorktree === true ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              {intl.formatMessage({ id: "projectSidebar.primary" })}
            </span>
          ) : null}
          {project.defaultWorkspaceId === workspace.workspaceId &&
          (project.defaultWorkspaceTargetId
            ? project.defaultWorkspaceTargetId === workspace.targetId
            : workspace.targetId === null) ? (
            <span className="shrink-0 text-ui-xs text-brand">
              {intl.formatMessage({ id: "projectSidebar.defaultWorkspace" })}
            </span>
          ) : null}
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
            {workspace.summary.agentCount}
          </span>
          {hasAttention ? (
            <span className="shrink-0 rounded-sm bg-warning/15 px-1 text-ui-xs text-warning">
              {workspace.summary.pendingInteractionCount + workspace.summary.errorCount}
            </span>
          ) : null}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          title={intl.formatMessage({ id: "projectSidebar.hideWorkspace" })}
          aria-label={intl.formatMessage(
            { id: "projectSidebar.hideWorkspaceNamed" },
            { workspace: displayTitle },
          )}
          onClick={() => hideWorkspace(workspace.targetId, workspace.workspaceId)}
          className="min-h-8 min-w-8 text-foreground-subtlest hover:text-foreground"
        >
          <EyeOffIcon className="size-4" />
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 pl-4">
        <HeadLabel workspace={workspace} />
        <span className="max-w-32 truncate font-mono text-ui-xs text-foreground-subtlest">
          {workspace.targetKind === "local"
            ? intl.formatMessage({ id: "projectSidebar.localTarget" })
            : (workspace.targetLabel ??
              intl.formatMessage({ id: "projectSidebar.targetNeedsVerification" }))}
        </span>
        <span className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage({ id: `projectSidebar.freshness.${workspace.targetFreshness}` })}
        </span>
      </div>
      {expanded ? (
        <div className="mt-1 space-y-0.5 pl-4">
          {workspace.sessions.map((row) => {
            const action = model.sessionActions.get(
              projectSidebarSessionViewKey(
                workspace.targetId,
                workspace.workspaceId,
                row.sessionId,
              ),
            );
            const selectable = Boolean(
              action?.selectable && (action.ownerKind === "native-v4" || onSelectExternalSession),
            );
            const reason =
              action?.reason === "needs-verification"
                ? intl.formatMessage({ id: "projectSidebar.sessionNeedsVerification" })
                : action?.reason === "external-session-mapping-unavailable" ||
                    action?.reason === "session-owner-unavailable"
                  ? intl.formatMessage({ id: "projectSidebar.sessionMappingUnavailable" })
                  : action?.ownerKind === "agent-host" && !onSelectExternalSession
                    ? intl.formatMessage({ id: "projectSidebar.externalTransportUnavailable" })
                    : action?.selectable
                      ? ""
                      : intl.formatMessage({ id: "projectSidebar.sessionMappingUnavailable" });
            return (
              <SessionRow
                key={projectSidebarSessionViewKey(
                  workspace.targetId,
                  workspace.workspaceId,
                  row.sessionId,
                )}
                row={row}
                selectable={selectable}
                reason={reason}
                onSelect={() => {
                  if (!selectable) return;
                  selectSession(
                    project.projectId,
                    workspace.targetId,
                    workspace.workspaceId,
                    row.sessionId,
                  );
                  if (action?.ownerKind === "agent-host") onSelectExternalSession?.(workspace, row);
                  else onSelectSession(workspace, row);
                }}
                dataOwnerKind={action?.ownerKind}
                dataOwnerLocatorAvailable={
                  action?.ownerKind === "agent-host" ? Boolean(action.ownerLocator) : undefined
                }
                targetId={workspace.targetId}
                manifest={targetView?.model.source.directory.entries.find(
                  (entry) => entry.manifest.id === row.harnessId,
                )?.manifest}
                appearance={appearance}
                loadAsset={loadAsset}
              />
            );
          })}
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={() => setAgentFormOpen(true)}
            disabled={!canOpenAgentForm}
            title={
              !canOpenAgentForm
                ? intl.formatMessage({ id: "projectSidebar.cachedReadOnly" })
                : undefined
            }
            className="min-h-8 w-full justify-start gap-2 px-2 text-left text-ui-sm text-foreground-subtle"
          >
            <PlusIcon className="size-4" />
            {intl.formatMessage({ id: "projectSidebar.addAgent" })}
          </Button>
          {agentFormOpen && targetOption && targetWorkspace ? (
            <ProjectSidebarAgentCreateForm
              workspace={workspace}
              targetOption={targetOption}
              targetServices={targetServices}
              worktreeGeneration={targetWorkspace.worktreeGeneration}
              appearance={appearance}
              targetLabel={targetLabel}
              loadAsset={loadAsset}
              onCancel={() => setAgentFormOpen(false)}
              onCreateAgent={(request) =>
                onCreateAgent(targetOption, workspace, targetWorkspace.worktreeGeneration, request).then(
                  () => setAgentFormOpen(false),
                )
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
