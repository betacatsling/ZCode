import { Button } from "@/components/ui/button.js";
import { HarnessIcon } from "@/agent-host/HarnessIcon.js";
import { SessionStatusIcon } from "@/agent-host/SessionStatusIcon.js";
import type { SidebarSessionNode } from "./planTypes.js";
import { formatSidebarRelativeTime } from "./orcaSidebarCopy.js";
import type { OrcaSidebarChrome } from "./orcaSidebarChrome.js";
import { sessionAttention } from "./sidebarAttention.js";

export function AgentSessionRow({
  row,
  chrome,
  active,
  onSelect,
}: {
  row: SidebarSessionNode;
  chrome: OrcaSidebarChrome;
  active: boolean;
  onSelect: (sessionId: string) => void;
}) {
  const { copy, locale, now } = chrome;
  const attention = sessionAttention(row);
  const relative = formatSidebarRelativeTime(row.updatedAt, now, locale);
  const model = row.modelLabel ? copy.model(row.modelLabel) : undefined;
  return (
    <Button
      type="button"
      variant="ghost"
      aria-current={active ? "true" : undefined}
      title={model ? `${row.session.title} · ${model}` : row.session.title}
      onClick={() => onSelect(row.session.id)}
      data-session-id={row.session.id}
      data-active={active ? "true" : "false"}
      className="min-h-9 w-full justify-start gap-2 rounded-md px-2 text-left text-ui-sm md:min-h-8"
    >
      <SessionStatusIcon
        attention={attention}
        activity={row.activity}
        freshness={row.freshness}
        recentOutcome={row.recentOutcome}
        label={copy.status[attention]}
        freshnessLabel={copy.freshness[row.freshness]}
      />
      <HarnessIcon
        harnessId={row.session.harnessId}
        directory={chrome.directory}
        assets={chrome.assets}
        appearance={chrome.appearance}
      />
      <span className="min-w-0 flex-1 truncate" data-session-title="true">
        {row.session.title}
      </span>
      {model ? (
        <span className="sr-only" data-model-label={row.modelLabel}>
          {model}
        </span>
      ) : null}
      <time
        dateTime={new Date(row.updatedAt).toISOString()}
        title={copy.updated(relative)}
        data-updated-at={row.updatedAt}
        className="shrink-0 text-ui-xs text-foreground-subtlest"
      >
        {relative}
      </time>
    </Button>
  );
}
