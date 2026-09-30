import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { acceptHarnessAssetSource } from "@/agent-host/HarnessIcon.js";
import type { SidebarProjectNode } from "./planTypes.js";
import type { OrcaSidebarChrome } from "./orcaSidebarChrome.js";
import { summarizeWorkspaces } from "./sidebarAttention.js";

function projectInitials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function ProjectNode({
  node,
  chrome,
  expanded,
  onToggle,
  onAddWorkspace,
  onOpenMenu,
  onRevealAttention,
  children,
}: {
  node: SidebarProjectNode;
  chrome: OrcaSidebarChrome;
  expanded: boolean;
  onToggle: (projectId: string) => void;
  onAddWorkspace: (projectId: string) => void;
  onOpenMenu: (projectId: string) => void;
  onRevealAttention: (projectId: string) => void;
  children: ReactNode;
}) {
  const { project } = node;
  const { copy } = chrome;
  const summary = summarizeWorkspaces(node.workspaces);
  const iconSource = project.iconAssetId
    ? acceptHarnessAssetSource(chrome.assets?.[project.iconAssetId])
    : null;
  const showAttention = summary.pendingCount > 0 || summary.errorCount > 0;
  return (
    <section
      data-project-id={project.id}
      data-agent-count={summary.agentCount}
      className="space-y-1"
    >
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          aria-expanded={expanded}
          onClick={() => onToggle(project.id)}
          className="min-h-9 min-w-0 flex-1 justify-start gap-2 px-1 text-left md:min-h-8"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
          {iconSource ? (
            <img
              src={iconSource}
              alt=""
              aria-hidden="true"
              className="size-4 shrink-0 object-contain"
            />
          ) : (
            <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-md bg-accent text-ui-xs text-foreground-subtle">
              {projectInitials(project.name)}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
            {project.name}
          </span>
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">{summary.agentCount}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={copy.addWorkspace}
          onClick={() => onAddWorkspace(project.id)}
          className="min-h-9 min-w-9 text-foreground-subtle md:min-h-8 md:min-w-8"
        >
          <PlusIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          aria-label={copy.more}
          onClick={() => onOpenMenu(project.id)}
          className="min-h-9 min-w-9 text-foreground-subtle md:min-h-8 md:min-w-8"
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </div>
      {showAttention ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => onRevealAttention(project.id)}
          data-attention-entry={project.id}
          className="min-h-9 w-full justify-start gap-2 px-2 text-left text-ui-sm text-warning md:min-h-8"
        >
          <span>{copy.pending(summary.pendingCount)}</span>
          {summary.runningCount > 0 ? <span>{copy.running(summary.runningCount)}</span> : null}
        </Button>
      ) : null}
      {expanded ? children : null}
    </section>
  );
}
