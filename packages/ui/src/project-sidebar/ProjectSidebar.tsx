import { useMemo, useState } from "react";
import type { WorktreeWorkspace } from "@zcode/shared/project-workspaces";
import { ProjectNode } from "./ProjectNode.js";
import {
  AgentCreationDialog,
  ConfirmationDialog,
  DiscoveredWorktreesDialog,
  WorkspaceCreationDialog,
} from "./SidebarDialogs.js";
import { useProjectSidebarViewStore } from "../store/projectSidebarViewStore.js";
import type { ProjectSidebarProps } from "./types.js";

function byOrder<T extends { sortOrder: number; id: string }>(left: T, right: T) {
  return left.sortOrder - right.sortOrder || left.id.localeCompare(right.id);
}

type Modal =
  | {
      kind: "agent" | "confirmation";
      workspace: WorktreeWorkspace;
      action?: "hide" | "archive" | "remove";
    }
  | { kind: "workspace" | "discovered"; bindingId: string };

/** Immutable host facts in; only explicit user actions out. Mount this component with host-backed callbacks. */
export function ProjectSidebar(props: ProjectSidebarProps) {
  const [modal, setModal] = useState<Modal>();
  const [discoveryError, setDiscoveryError] = useState("");
  const scrollTop = useProjectSidebarViewStore((state) => state.scrollTop);
  const setScrollTop = useProjectSidebarViewStore((state) => state.setScrollTop);
  const { projects, bindings, workspaces, sessions, workspaceSummaries, projectSummaries } =
    props.snapshot;
  const sortedProjects = useMemo(() => [...projects].sort(byOrder), [projects]);
  const sortedWorkspaces = useMemo(() => [...workspaces].sort(byOrder), [workspaces]);
  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => byOrder(a.session, b.session)),
    [sessions],
  );
  const summaryByWorkspace = useMemo(
    () => new Map(workspaceSummaries.map((value) => [value.workspaceId, value])),
    [workspaceSummaries],
  );
  const summaryByProject = useMemo(
    () => new Map(projectSummaries.map((value) => [value.projectId, value])),
    [projectSummaries],
  );
  function confirmWorkspace(workspace: WorktreeWorkspace, action: "hide" | "archive" | "remove") {
    if (action === "hide") return props.actions.onHideWorkspace(workspace.id);
    if (action === "archive") return props.actions.onArchiveWorkspace(workspace.id);
    return props.actions.onRemoveWorkspace(workspace.id, workspace.worktreeGeneration);
  }
  const confirmationText =
    props.locale === "zh"
      ? {
          hide: "仅隐藏显示；Agent 继续运行，项目待处理入口仍可访问。",
          archive: "归档改变目录展示与新会话准入，不会停止运行中的会话。请先检查活动状态。",
          remove:
            "移除 linked worktree 可能丢失修改或未跟踪文件。外部进程、锁和活动可能无法全部检测；宿主必须重新检查 Git 和活动。历史保留，不删除分支。",
        }
      : {
          hide: "Hide only changes visibility; agents keep running and attention stays accessible.",
          archive:
            "Archive changes catalog display and admission, not running sessions. Check active work before continuing.",
          remove:
            "Removing a linked worktree can lose modified or untracked files. External activity, locks and processes may not be visible. The host must check activity and Git again before removal; history stays readable. This does not delete the branch.",
        };
  const actionLabels =
    props.locale === "zh"
      ? { hide: "隐藏", archive: "归档", remove: "移除" }
      : { hide: "hide", archive: "archive", remove: "remove" };
  async function discover(bindingId: string) {
    setDiscoveryError("");
    try {
      await props.actions.onDiscover(bindingId);
      setModal({ kind: "discovered", bindingId });
    } catch (cause) {
      setDiscoveryError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <>
      <nav
        aria-label={props.locale === "zh" ? "项目和 Agent" : "Projects and agents"}
        className="min-h-0 w-full overflow-auto bg-sidebar p-2 text-ui-base text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        ref={(element) => {
          if (element && element.dataset.restored !== "true") {
            element.scrollTop = scrollTop;
            element.dataset.restored = "true";
          }
        }}
      >
        {discoveryError ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {discoveryError}
          </p>
        ) : null}
        {sortedProjects.map((project) => {
          const projectSummary = summaryByProject.get(project.id);
          if (!projectSummary) return null;
          return (
            <ProjectNode
              key={project.id}
              project={project}
              summary={projectSummary}
              bindings={bindings.filter((binding) => binding.projectId === project.id)}
              workspaces={sortedWorkspaces.filter(
                (workspace) => workspace.projectId === project.id,
              )}
              workspaceSummaries={summaryByWorkspace}
              sessions={sortedSessions.filter(
                (summary) => summary.session.projectId === project.id,
              )}
              props={props}
              onCreateAgent={(workspace) => setModal({ kind: "agent", workspace })}
              onConfirm={(workspace, action) =>
                setModal({ kind: "confirmation", workspace, action })
              }
              onCreateWorkspace={(bindingId) => setModal({ kind: "workspace", bindingId })}
              onDiscover={discover}
            />
          );
        })}
      </nav>
      {modal?.kind === "agent" ? (
        <AgentCreationDialog
          workspaceId={modal.workspace.id}
          generation={modal.workspace.worktreeGeneration}
          props={props}
          onClose={() => setModal(undefined)}
        />
      ) : null}
      {modal?.kind === "workspace" ? (
        <WorkspaceCreationDialog
          bindingId={modal.bindingId}
          props={props}
          onClose={() => setModal(undefined)}
        />
      ) : null}
      {modal?.kind === "discovered" ? (
        <DiscoveredWorktreesDialog
          bindingId={modal.bindingId}
          candidates={props.discovery?.[modal.bindingId] ?? []}
          props={props}
          onClose={() => setModal(undefined)}
        />
      ) : null}
      {modal?.kind === "confirmation" && modal.action ? (
        <ConfirmationDialog
          title={`${props.locale === "zh" ? actionLabels[modal.action] : `${modal.action.charAt(0).toUpperCase()}${modal.action.slice(1)}`} ${modal.workspace.title}?`}
          description={confirmationText[modal.action]}
          confirmLabel={
            props.locale === "zh" ? `确认${actionLabels[modal.action]}` : `Confirm ${modal.action}`
          }
          cancelLabel={props.locale === "zh" ? "取消" : "Cancel"}
          onClose={() => setModal(undefined)}
          onConfirm={() => confirmWorkspace(modal.workspace, modal.action!)}
        />
      ) : null}
    </>
  );
}
export type {
  ProjectSidebarProps,
  SidebarActions,
  DiscoveryCandidate,
  CreateAgentInput,
  CreateWorkspaceInput,
} from "./types.js";
