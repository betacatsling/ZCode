import type {
  WorktreeWorkspace,
  WorkspaceSummary,
  SessionSummary,
  RepositoryBinding,
  Project,
} from "@zcode/shared/project-workspaces";
import { Button } from "../components/ui/button.js";
import { labels } from "../agent-host/labels.js";
import { useProjectSidebarViewStore } from "../store/projectSidebarViewStore.js";
import { AgentSessionRow } from "./AgentSessionRow.js";
import type { ProjectSidebarProps } from "./types.js";

export function WorktreeWorkspaceNode({
  workspace,
  project,
  binding,
  summary,
  sessions,
  props,
  onCreateAgent,
  onConfirm,
}: {
  workspace: WorktreeWorkspace;
  project: Project;
  binding: RepositoryBinding;
  summary: WorkspaceSummary;
  sessions: readonly SessionSummary[];
  props: ProjectSidebarProps;
  onCreateAgent: () => void;
  onConfirm: (action: "hide" | "show" | "archive" | "unarchive" | "remove") => void;
}) {
  const expanded = useProjectSidebarViewStore((s) => s.expandedWorkspaces[workspace.id] !== false);
  const setExpanded = useProjectSidebarViewStore((s) => s.setWorkspaceExpanded);
  const l = labels[props.locale];
  const isActive = workspace.lifecycle === "active" && !workspace.archived;
  return (
    <section data-testid={`workspace-${workspace.id}`} className="border-l border-border pl-2">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          type="button"
          aria-label={`${props.locale === "zh" ? (expanded ? "折叠" : "展开") : expanded ? "Collapse" : "Expand"} ${workspace.title}`}
          aria-expanded={expanded}
          onClick={() => setExpanded(workspace.id, !expanded)}
        >
          {expanded ? "⌄" : "›"}
        </Button>
        <span className="min-w-0 flex-1 truncate font-medium" title={workspace.title}>
          {workspace.title}
        </span>
        {workspace.isMainWorktree ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">{l.main}</span>
        ) : null}
        {project.defaultWorkspaceId === workspace.id ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">{l.default}</span>
        ) : null}
      </div>
      <p className="pl-7 text-ui-sm text-foreground-subtle" title={workspace.worktreePath}>
        {props.targetLabels[binding.executionTargetId] ?? binding.executionTargetId} ·{" "}
        {workspace.head.kind === "branch"
          ? workspace.head.ref
          : `${l.detached} ${workspace.head.oid.slice(0, 8)}`}{" "}
        · {workspace.lifecycle}
      </p>
      <div className="flex flex-wrap items-center gap-1 pl-7 text-ui-xs text-foreground-subtle">
        <span>
          {summary.totalAgents} {l.agents}
        </span>
        {summary.waiting ? (
          <span>
            {summary.waiting} {l.waiting}
          </span>
        ) : null}
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
        {summary.freshness !== "live" ? <span>{l[summary.freshness]}</span> : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!isActive}
          aria-label={`${props.locale === "zh" ? "新建 Agent" : "New agent in"} ${workspace.title}`}
          onClick={onCreateAgent}
        >
          + Agent
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`${props.locale === "zh" ? (workspace.hidden ? "显示" : "隐藏") : workspace.hidden ? "Show" : "Hide"} ${workspace.title}`}
          onClick={() => onConfirm(workspace.hidden ? "show" : "hide")}
          disabled={workspace.hidden && !props.actions.onShowWorkspace}
        >
          {props.locale === "zh"
            ? workspace.hidden
              ? "显示"
              : "隐藏"
            : workspace.hidden
              ? "Show"
              : "Hide"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`${props.locale === "zh" ? (workspace.archived ? "取消归档" : "归档") : workspace.archived ? "Unarchive" : "Archive"} ${workspace.title}`}
          onClick={() => onConfirm(workspace.archived ? "unarchive" : "archive")}
          disabled={Boolean(workspace.archived && !props.actions.onUnarchiveWorkspace)}
        >
          {props.locale === "zh"
            ? workspace.archived
              ? "取消归档"
              : "归档"
            : workspace.archived
              ? "Unarchive"
              : "Archive"}
        </Button>
        {!workspace.isMainWorktree ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${props.locale === "zh" ? "移除" : "Remove"} ${workspace.title}`}
            onClick={() => onConfirm("remove")}
          >
            {props.locale === "zh" ? "移除" : "Remove"}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className="pl-5">
          {sessions
            .filter((session) => !session.session.archived)
            .map((session) => (
              <AgentSessionRow key={session.session.id} summary={session} props={props} />
            ))}
        </div>
      ) : null}
    </section>
  );
}
