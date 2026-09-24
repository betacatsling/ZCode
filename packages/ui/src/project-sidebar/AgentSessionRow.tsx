import type { SessionSummary } from "@zcode/shared/project-workspaces";
import { HarnessIcon } from "../agent-host/HarnessIcon.js";
import { SessionStatusIcon } from "../agent-host/SessionStatusIcon.js";
import { useProjectSidebarViewStore } from "../store/projectSidebarViewStore.js";
import type { ProjectSidebarProps } from "./types.js";

export function AgentSessionRow({
  summary,
  props,
}: {
  summary: SessionSummary;
  props: ProjectSidebarProps;
}) {
  const id = summary.session.id;
  const selected = useProjectSidebarViewStore((s) => s.selectedSessionId === id);
  const select = useProjectSidebarViewStore((s) => s.selectSession);
  const model = props.modelLabels?.[id];
  return (
    <button
      type="button"
      data-testid={`session-${id}`}
      title={model ? `${summary.session.title} · ${model}` : summary.session.title}
      aria-current={selected ? "page" : undefined}
      className={`flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base hover:bg-hover focus-visible:outline-2 focus-visible:outline-primary ${selected ? "bg-selected" : ""}`}
      onClick={() => {
        select(id);
        props.actions.onSelectSession(summary);
      }}
    >
      <SessionStatusIcon summary={summary} locale={props.locale} />
      <HarnessIcon
        harnessId={summary.session.harnessId}
        catalog={props.catalog}
        resolveIconAsset={props.resolveIconAsset}
      />
      <span className="min-w-0 flex-1 truncate">{summary.session.title}</span>
      <time
        className="shrink-0 text-ui-xs text-foreground-subtlest"
        dateTime={new Date(summary.updatedAt).toISOString()}
      >
        {new Date(summary.updatedAt).toLocaleTimeString(props.locale, {
          hour: "numeric",
          minute: "2-digit",
        })}
      </time>
    </button>
  );
}
