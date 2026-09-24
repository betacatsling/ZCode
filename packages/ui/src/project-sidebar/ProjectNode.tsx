import { useState } from "react";
import { Folder } from "lucide-react";
import { safeIconUrl } from "../agent-host/HarnessIcon.js";
import type {
  Project,
  ProjectSummary,
  RepositoryBinding,
  WorktreeWorkspace,
  WorkspaceSummary,
  SessionSummary,
} from "@zcode/shared/project-workspaces";
import { Button } from "../components/ui/button.js";
import { labels } from "../agent-host/labels.js";
import { useProjectSidebarViewStore } from "../store/projectSidebarViewStore.js";
import { WorktreeWorkspaceNode } from "./WorktreeWorkspaceNode.js";
import type { ProjectSidebarProps } from "./types.js";

export function ProjectNode({
  project,
  summary,
  bindings,
  workspaces,
  workspaceSummaries,
  sessions,
  props,
  onCreateAgent,
  onConfirm,
  onCreateWorkspace,
  onDiscover,
}: {
  project: Project;
  summary: ProjectSummary;
  bindings: readonly RepositoryBinding[];
  workspaces: readonly WorktreeWorkspace[];
  workspaceSummaries: ReadonlyMap<string, WorkspaceSummary>;
  sessions: readonly SessionSummary[];
  props: ProjectSidebarProps;
  onCreateAgent: (workspace: WorktreeWorkspace) => void;
  onConfirm: (workspace: WorktreeWorkspace, action: "hide" | "archive" | "remove") => void;
  onCreateWorkspace: (bindingId: string) => void;
  onDiscover: (bindingId: string) => void;
}) {
  const expanded = useProjectSidebarViewStore((s) => s.expandedProjects[project.id] !== false);
  const setExpanded = useProjectSidebarViewStore((s) => s.setProjectExpanded);
  const showHidden = useProjectSidebarViewStore(
    (s) => s.expandedHiddenWorkspaces[project.id] === true,
  );
  const setHiddenExpanded = useProjectSidebarViewStore((s) => s.setHiddenWorkspacesExpanded);
  const [brokenIcon, setBrokenIcon] = useState<string>();
  const iconUrl = safeIconUrl(project.iconAssetId, props.resolveIconAsset);
  const l = labels[props.locale];
  const visible = workspaces.filter((w) => !w.hidden && w.lifecycle !== "removed");
  const hidden = workspaces.filter((w) => w.hidden && w.lifecycle !== "removed");
  return (
    <section data-testid={`project-${project.id}`} className="border-b border-border pb-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`${props.locale === "zh" ? (expanded ? "折叠" : "展开") : expanded ? "Collapse" : "Expand"} ${project.name}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(project.id, !expanded)}
        >
          {expanded ? "⌄" : "›"}
        </Button>
        {iconUrl && brokenIcon !== iconUrl ? (
          <img
            src={iconUrl}
            alt=""
            className="size-4 shrink-0 object-contain"
            onError={() => setBrokenIcon(iconUrl)}
          />
        ) : (
          <Folder className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        )}
        <h2 className="min-w-0 flex-1 truncate font-medium" title={project.name}>
          {project.name}
        </h2>
        {bindings.map((binding) => (
          <span key={binding.id} className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`${props.locale === "zh" ? "发现工作区" : "Discover worktrees in"} ${project.name}`}
              onClick={() => onDiscover(binding.id)}
            >
              {props.locale === "zh" ? "发现" : "Discover"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`${props.locale === "zh" ? "创建隔离工作区" : "Create isolated workspace in"} ${project.name}`}
              onClick={() => onCreateWorkspace(binding.id)}
            >
              + {props.locale === "zh" ? "工作区" : "Workspace"}
            </Button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2 pl-7 text-ui-xs text-foreground-subtle">
        <span>
          {summary.totalAgents} {l.agents}
        </span>
        <span>
          {summary.waiting} {l.waiting}
        </span>
        {summary.errors ? (
          <span>
            {summary.errors} {l.errors}
          </span>
        ) : null}
        {summary.running ? (
          <span>
            {summary.running} {l.running}
          </span>
        ) : null}
        {summary.unreadCompleted ? (
          <span>
            {summary.unreadCompleted} {l.unread}
          </span>
        ) : null}
      </div>
      {summary.attentionSessionIds.length ? (
        <div className="flex flex-wrap gap-1 pl-7">
          {summary.attentionSessionIds.map((id) => {
            const session = sessions.find((s) => s.session.id === id);
            return (
              <Button
                key={id}
                type="button"
                size="sm"
                variant="outline"
                aria-label={`${props.locale === "zh" ? "待处理" : "Attention"}: ${session?.session.title ?? id}`}
                onClick={() => props.actions.onOpenAttention(id)}
              >
                {l.waiting}: {session?.session.title ?? id}
              </Button>
            );
          })}
        </div>
      ) : null}
      {expanded ? (
        <div className="space-y-1 pl-2">
          {visible.concat(showHidden ? hidden : []).map((workspace) => {
            const binding = bindings.find((b) => b.id === workspace.repositoryBindingId);
            const wsSummary = workspaceSummaries.get(workspace.id);
            if (!binding || !wsSummary) return null;
            return (
              <WorktreeWorkspaceNode
                key={workspace.id}
                workspace={workspace}
                project={project}
                binding={binding}
                summary={wsSummary}
                sessions={sessions.filter((s) => s.session.workspaceId === workspace.id)}
                props={props}
                onCreateAgent={() => onCreateAgent(workspace)}
                onConfirm={(action) => onConfirm(workspace, action)}
              />
            );
          })}
          {hidden.length ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={showHidden}
              onClick={() => setHiddenExpanded(project.id, !showHidden)}
            >
              {props.locale === "zh"
                ? `已隐藏 ${hidden.length} 个工作区`
                : `${hidden.length} hidden workspaces`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
