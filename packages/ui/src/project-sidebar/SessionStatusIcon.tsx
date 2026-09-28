import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SidebarSessionRow } from "@zcode/shared/agent-host";

export function SessionStatusIcon({ row }: { row: SidebarSessionRow }) {
  const { intl } = useZCodeIntl();
  if (row.pendingInteractionCount > 0) {
    return (
      <MessageCircleQuestionIcon
        aria-label={intl.formatMessage({ id: "projectSidebar.status.pending" })}
        className="size-3.5 text-warning"
      />
    );
  }
  if (row.activity === "running" || row.activity === "starting" || row.activity === "cancelling") {
    return (
      <LoaderCircleIcon
        aria-label={intl.formatMessage({ id: "projectSidebar.status.running" })}
        className="size-3.5 animate-spin text-warning"
      />
    );
  }
  if (row.recentOutcome === "failed") {
    return (
      <CircleAlertIcon
        aria-label={intl.formatMessage({ id: "projectSidebar.status.failed" })}
        className="size-3.5 text-destructive"
      />
    );
  }
  if (row.recentOutcome === "success") {
    return (
      <CircleCheckIcon
        aria-label={intl.formatMessage({ id: "projectSidebar.status.completed" })}
        className="size-3.5 text-success"
      />
    );
  }
  if (row.activity === "unknown" || row.freshness === "unknown") {
    return (
      <CircleHelpIcon
        aria-label={intl.formatMessage({ id: "projectSidebar.status.unknown" })}
        className="size-3.5 text-foreground-subtlest"
      />
    );
  }
  return (
    <CircleDotIcon
      aria-label={intl.formatMessage({ id: "projectSidebar.status.idle" })}
      className="size-3.5 text-foreground-subtle"
    />
  );
}
