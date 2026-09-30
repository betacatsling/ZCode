import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import type { ModelBindingOption } from "@/agent-host/ModelBindingSelector.js";
import type { CapabilityReport } from "@/agent-host/SessionCapabilities.js";
import {
  DiscoveredWorktreesDialog,
  type DiscoveredWorktreeCandidate,
} from "./DiscoveredWorktreesDialog.js";
import type { OrcaSidebarChrome } from "./orcaSidebarChrome.js";
import { orcaSidebarCopy } from "./orcaSidebarCopy.js";
import { ProjectNode } from "./ProjectNode.js";
import type { SidebarSnapshot } from "./planTypes.js";
import {
  orderByIds,
  type AgentCreationDraft,
  type OrcaSidebarViewData,
  type WorkspaceCreationDraft,
} from "./sidebarViewStore.js";
import { WorkspaceCreationDialog } from "./WorkspaceCreationDialog.js";
import { WorktreeWorkspaceNode } from "./WorktreeWorkspaceNode.js";

export interface OrcaSidebarHandlers {
  onToggleProject: (projectId: string) => void;
  onToggleWorkspace: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onAddWorkspace: (projectId: string) => void;
  onOpenMenu: (projectId: string) => void;
  onRevealAttention: (projectId: string) => void;
  onWorkspaceDraftChange: (draft: WorkspaceCreationDraft) => void;
  onCancelWorkspace: () => void;
  onSubmitWorkspace: (projectId: string, draft: WorkspaceCreationDraft) => void;
  onOpenDiscovered: (projectId: string) => void;
  onCloseDiscovered: () => void;
  onAdoptDiscovered: (projectId: string, candidateId: string) => void;
  onOpenAgent: (workspaceId: string) => void;
  onAgentDraftChange: (draft: AgentCreationDraft) => void;
  onCloseAgent: () => void;
  onCreateAgent: (workspaceId: string, draft: AgentCreationDraft) => void;
  onScroll?: (scrollTop: number) => void;
}

/**
 * 受控的三层侧栏。快照只负责展示；选中、展开和草稿都来自 view。
 * 组件不在渲染或 effect 里改选中项，也不调用 focus()，因此后台状态更新不会抢走焦点。
 * 不挂到生产路由。
 */
export function OrcaProjectSidebar({
  snapshot,
  view,
  directory,
  assets,
  appearance,
  now,
  query = "",
  models,
  report,
  discoveredByProject,
  handlers,
}: {
  snapshot: SidebarSnapshot;
  view: OrcaSidebarViewData;
  directory: OrcaSidebarChrome["directory"];
  assets?: OrcaSidebarChrome["assets"];
  appearance: "light" | "dark";
  now: number;
  query?: string;
  models: readonly ModelBindingOption[];
  report: CapabilityReport;
  discoveredByProject: Readonly<Record<string, readonly DiscoveredWorktreeCandidate[]>>;
  handlers: OrcaSidebarHandlers;
}) {
  const { locale } = useZCodeIntl();
  const copy = orcaSidebarCopy(locale);
  const chrome: OrcaSidebarChrome = {
    copy,
    locale,
    now,
    appearance,
    directory,
    assets,
    query,
  };
  const projects = orderByIds(
    snapshot.projects.map((node) => ({ ...node, id: node.project.id })),
    view.projectOrder,
    view.pinnedProjectIds,
  );
  return (
    <nav
      data-orca-sidebar="true"
      aria-label={copy.navLabel}
      className="flex h-full min-h-0 w-full flex-col bg-sidebar text-foreground"
      onScroll={(event) => handlers.onScroll?.(event.currentTarget.scrollTop)}
    >
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-2">
        {projects.map((node) => {
          const expanded = view.expandedProjectIds.includes(node.project.id);
          const workspaces = orderByIds(
            node.workspaces.map((workspace) => ({ ...workspace, id: workspace.workspace.id })),
            view.workspaceOrder,
          ).filter((workspace) => !view.hiddenWorkspaceIds.includes(workspace.workspace.id));
          return (
            <ProjectNode
              key={node.project.id}
              node={node}
              chrome={chrome}
              expanded={expanded}
              onToggle={handlers.onToggleProject}
              onAddWorkspace={handlers.onAddWorkspace}
              onOpenMenu={handlers.onOpenMenu}
              onRevealAttention={handlers.onRevealAttention}
            >
              <WorkspaceCreationDialog
                open={view.workspaceDialogProjectId === node.project.id}
                projectName={node.project.name}
                targetLabel={
                  node.workspaces[0]?.targetLabel ?? node.repositoryBinding.executionTargetId
                }
                draft={view.workspaceDraft}
                copy={copy}
                onDraftChange={handlers.onWorkspaceDraftChange}
                onCancel={handlers.onCancelWorkspace}
                onSubmit={(draft) => handlers.onSubmitWorkspace(node.project.id, draft)}
              />
              {workspaces.map((workspace) => (
                <WorktreeWorkspaceNode
                  key={workspace.workspace.id}
                  project={node.project}
                  node={workspace}
                  chrome={chrome}
                  expanded={view.expandedWorkspaceIds.includes(workspace.workspace.id)}
                  activeSessionId={view.activeSessionId}
                  agentOpen={view.agentWorkspaceId === workspace.workspace.id}
                  agentDraft={view.agentDraft}
                  models={models}
                  report={report}
                  onToggle={handlers.onToggleWorkspace}
                  onSelectSession={handlers.onSelectSession}
                  onOpenAgent={handlers.onOpenAgent}
                  onAgentDraftChange={handlers.onAgentDraftChange}
                  onCloseAgent={handlers.onCloseAgent}
                  onCreateAgent={handlers.onCreateAgent}
                />
              ))}
              {node.hiddenDiscoveredCount > 0 ? (
                <div className="flex items-center gap-2 pl-2">
                  <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtle">
                    {copy.hiddenDiscovered(node.hiddenDiscoveredCount)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handlers.onOpenDiscovered(node.project.id)}
                    className="min-h-9 px-2 text-ui-xs md:min-h-8"
                  >
                    {copy.manage}
                  </Button>
                </div>
              ) : null}
              <DiscoveredWorktreesDialog
                open={view.discoveredProjectId === node.project.id}
                projectName={node.project.name}
                candidates={discoveredByProject[node.project.id] ?? []}
                copy={copy}
                onAdopt={(candidateId) => handlers.onAdoptDiscovered(node.project.id, candidateId)}
                onClose={handlers.onCloseDiscovered}
              />
            </ProjectNode>
          );
        })}
      </div>
    </nav>
  );
}
