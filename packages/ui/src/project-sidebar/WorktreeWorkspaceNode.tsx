import { ChevronDownIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { ModelBindingOption } from "@/agent-host/ModelBindingSelector.js";
import type { CapabilityReport } from "@/agent-host/SessionCapabilities.js";
import { AgentCreatePanel } from "./AgentCreatePanel.js";
import { AgentSessionRow } from "./AgentSessionRow.js";
import type { OrcaSidebarChrome } from "./orcaSidebarChrome.js";
import type { Project, SidebarWorkspaceNode } from "./planTypes.js";
import { summarizeSessions, visibleSessions } from "./sidebarAttention.js";
import type { AgentCreationDraft } from "./sidebarViewStore.js";

export function WorktreeWorkspaceNode({
  project,
  node,
  chrome,
  expanded,
  activeSessionId,
  agentOpen,
  agentDraft,
  models,
  report,
  onToggle,
  onSelectSession,
  onOpenAgent,
  onAgentDraftChange,
  onCloseAgent,
  onCreateAgent,
}: {
  project: Project;
  node: SidebarWorkspaceNode;
  chrome: OrcaSidebarChrome;
  expanded: boolean;
  activeSessionId: string | null;
  agentOpen: boolean;
  agentDraft: AgentCreationDraft;
  models: readonly ModelBindingOption[];
  report: CapabilityReport;
  onToggle: (workspaceId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onOpenAgent: (workspaceId: string) => void;
  onAgentDraftChange: (draft: AgentCreationDraft) => void;
  onCloseAgent: () => void;
  onCreateAgent: (workspaceId: string, draft: AgentCreationDraft) => void;
}) {
  const { workspace } = node;
  const { copy } = chrome;
  const summary = summarizeSessions(node.sessions);
  const listed = visibleSessions(node.sessions, chrome.query);
  const isDefault = project.defaultWorkspaceId === workspace.id;
  const head =
    workspace.head.kind === "branch" ? workspace.head.ref : copy.detachedHead(workspace.head.oid);
  return (
    <section
      data-workspace-id={workspace.id}
      data-main-worktree={workspace.isMainWorktree ? "true" : "false"}
      data-agent-count={summary.agentCount}
      data-pending-count={summary.pendingCount}
      data-running-count={summary.runningCount}
      className="space-y-1"
    >
      <div className="flex items-start gap-1">
        <Button
          type="button"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => onToggle(workspace.id)}
          className="min-h-9 min-w-0 flex-1 flex-wrap justify-start gap-x-2 gap-y-0.5 px-1 text-left md:min-h-8"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
          <span className="min-w-0 truncate text-ui-sm text-foreground">{workspace.title}</span>
          {workspace.isMainWorktree ? (
            <span data-main-badge="true" className="shrink-0 text-ui-xs text-foreground-subtle">
              {copy.mainCheckout}
            </span>
          ) : null}
          {isDefault ? (
            <span data-default-badge="true" className="shrink-0 text-ui-xs text-foreground-subtle">
              {copy.defaultWorkspace}
            </span>
          ) : null}
          <span className="basis-full truncate pl-5 text-ui-xs text-foreground-subtlest md:basis-auto md:pl-0">
            [{node.targetLabel}] {head}
          </span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={copy.addAgent}
          onClick={() => onOpenAgent(workspace.id)}
          className="min-h-9 min-w-9 text-foreground-subtle md:min-h-8 md:min-w-8"
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-5 text-ui-xs text-foreground-subtle">
        <span>{copy.agents(summary.agentCount)}</span>
        {summary.pendingCount > 0 ? (
          <span data-pending-label="true">{copy.pending(summary.pendingCount)}</span>
        ) : null}
        {summary.runningCount > 0 ? (
          <span data-running-label="true">{copy.running(summary.runningCount)}</span>
        ) : null}
        {chrome.query.trim() ? (
          <span data-match-label="true">{copy.match(listed.matched, listed.total)}</span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={() => onToggle(workspace.id)}
          className="h-6 px-1 text-ui-xs text-foreground-subtlest"
        >
          {expanded ? copy.collapse : copy.expand}
        </Button>
      </div>
      {agentOpen ? (
        <AgentCreatePanel
          workspaceTitle={workspace.title}
          targetLabel={node.targetLabel}
          draft={agentDraft}
          models={models}
          report={report}
          chrome={chrome}
          onDraftChange={onAgentDraftChange}
          onCancel={onCloseAgent}
          onCreate={(draft) => onCreateAgent(workspace.id, draft)}
        />
      ) : null}
      {expanded ? (
        <div className="space-y-0.5 pl-4">
          {listed.visible.map((row) => (
            <AgentSessionRow
              key={row.session.id}
              row={row}
              chrome={chrome}
              active={activeSessionId === row.session.id}
              onSelect={onSelectSession}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
