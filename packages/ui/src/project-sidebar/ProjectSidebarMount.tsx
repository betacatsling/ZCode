import type { ReactNode } from "react";
import type { Theme } from "@/useTheme.js";
import { resolveTheme } from "@/useTheme.js";
import type { RemoteTarget } from "@zcode/shared";
import type { ProjectSidebarAgentHostAttachment } from "./contract.js";
import { projectSidebarSessionViewKey } from "./viewKeys.js";
import { projectSidebarLegacyTaskExclusionKey } from "./legacyTaskExclusions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProjectWorkspaceSidebar } from "@/hooks/useProjectWorkspaceSidebar.js";
import { ProjectSidebar } from "./ProjectSidebar.js";
import { ProjectSidebarMountView } from "./ProjectSidebarMountView.js";

export function ProjectSidebarMount({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  theme,
  fallback,
  onSelectTask,
  onSelectExternalSession,
  onReconnectTarget,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  theme: Theme;
  fallback: ReactNode | ((excludedTaskKeys: ReadonlySet<string>) => ReactNode);
  onSelectTask: (
    workspacePath: string,
    sessionId: string,
    workspaceIdentity?: string,
    remoteSessionId?: string | null,
    targetId?: string,
    targetKind?: "local" | "remote",
    remoteTarget?: RemoteTarget,
  ) => void;
  onSelectExternalSession?: (selection: ProjectSidebarAgentHostAttachment) => void;
  onReconnectTarget?: () => void;
}): ReactNode {
  const { intl } = useZCodeIntl();
  const renderFallback = (excludedTaskKeys: ReadonlySet<string> = new Set()) =>
    typeof fallback === "function" ? fallback(excludedTaskKeys) : fallback;
  const sidebar = useProjectWorkspaceSidebar({
    workspacePath,
    workspaceIdentity,
    remoteSessionId: workspaceRemoteSessionId,
    theme,
  });
  if (sidebar.loadState.status !== "ready" && sidebar.loadState.status !== "refreshing") {
    return (
      <ProjectSidebarMountView
        loadState={sidebar.loadState}
        fallback={renderFallback()}
        unavailableReason={
          sidebar.loadState.status === "unavailable" ? (
            <p
              role="status"
              className="px-2 py-1 text-ui-xs text-foreground-subtle"
              data-project-sidebar-fallback-reason={sidebar.loadState.reason}
            >
              {intl.formatMessage({ id: "projectSidebar.unavailableFallback" })}
            </p>
          ) : undefined
        }
      >
        {null}
      </ProjectSidebarMountView>
    );
  }
  const { model } = sidebar.loadState;
  const mappedNativeTaskKeys = new Set<string>();
  for (const action of model.sessionActions.values()) {
    if (action.ownerKind !== "native-v4" || !action.selectable || action.workspacePath === null)
      continue;
    mappedNativeTaskKeys.add(
      projectSidebarLegacyTaskExclusionKey({
        taskId: action.nativeSessionId,
        workspacePath: action.workspacePath,
        workspaceIdentity: action.workspaceIdentity,
      }),
    );
  }
  return (
    <ProjectSidebarMountView
      loadState={sidebar.loadState}
      fallback={renderFallback()}
      legacySupplement={renderFallback(mappedNativeTaskKeys)}
      legacySummary={intl.formatMessage({ id: "projectSidebar.legacyHistory" })}
    >
      {() => (
        <ProjectSidebar
          model={model}
          targetOptions={sidebar.targetOptions}
          getTargetServices={sidebar.getTargetServices}
          loadHarnessAsset={sidebar.loadHarnessAsset}
          appearance={resolveTheme(theme)}
          onReconnectTarget={onReconnectTarget}
          onRefresh={sidebar.refresh}
          onAddProject={(target, name, path, selection, existingProjectId) =>
            sidebar.addProjectAndAdopt(target, name, path, selection, existingProjectId)
          }
          onCreateWorkspace={sidebar.createWorkspace}
          onRecoverWorkspace={sidebar.recoverWorkspaceCreation}
          onCreateAgent={async (target, workspace, worktreeGeneration, request) => {
            const action = await sidebar.createWorkspaceAgent(
              target,
              workspace.workspaceId,
              worktreeGeneration,
              request,
            );
            if (action.ownerKind === "native-v4") {
              if (!action.workspacePath)
                throw new Error("project-sidebar-created-owner-path-missing");
              onSelectTask(
                action.workspacePath,
                action.nativeSessionId,
                action.workspaceIdentity,
                action.remoteSessionId,
                action.targetId,
                action.isLocal ? "local" : "remote",
                action.remoteTarget,
              );
              return;
            }
            if (!action.ownerLocator || !onSelectExternalSession) {
              throw new Error("project-sidebar-created-owner-locator-unavailable");
            }
            onSelectExternalSession({
              ...action.ownerLocator,
              remoteSessionId: action.remoteSessionId,
              ...(action.remoteTarget ? { remoteTarget: action.remoteTarget } : {}),
            });
          }}
          onOpenHistoryRecord={async (targetId, record) => {
            const route = await sidebar.openHistoryRecord(targetId, record);
            if (route.status === "waiting") return false;
            if (route.status === "native") {
              const action = route.action;
              if (!action.workspacePath) return false;
              onSelectTask(
                action.workspacePath,
                action.nativeSessionId,
                action.workspaceIdentity,
                action.remoteSessionId,
                action.targetId,
                action.isLocal ? "local" : "remote",
                action.remoteTarget,
              );
              return true;
            }
            if (!onSelectExternalSession) return false;
            onSelectExternalSession(route.selection);
            return true;
          }}
          onSelectSession={(workspace, row) => {
            const action = model.sessionActions.get(
              projectSidebarSessionViewKey(
                workspace.targetId,
                workspace.workspaceId,
                row.sessionId,
              ),
            );
            if (
              !action?.selectable ||
              action.ownerKind !== "native-v4" ||
              action.workspacePath === null
            )
              return;
            onSelectTask(
              action.workspacePath,
              action.nativeSessionId,
              action.workspaceIdentity,
              action.remoteSessionId,
              action.targetId,
              action.isLocal ? "local" : "remote",
              action.remoteTarget,
            );
          }}
          onSelectExternalSession={
            onSelectExternalSession
              ? (workspace, row) => {
                  const action = model.sessionActions.get(
                    projectSidebarSessionViewKey(
                      workspace.targetId,
                      workspace.workspaceId,
                      row.sessionId,
                    ),
                  );
                  if (
                    !action?.selectable ||
                    action.ownerKind !== "agent-host" ||
                    !action.ownerLocator
                  ) {
                    return;
                  }
                  onSelectExternalSession({
                    ...action.ownerLocator,
                    remoteSessionId: action.remoteSessionId,
                    ...(action.remoteTarget ? { remoteTarget: action.remoteTarget } : {}),
                  });
                }
              : undefined
          }
        />
      )}
    </ProjectSidebarMountView>
  );
}
