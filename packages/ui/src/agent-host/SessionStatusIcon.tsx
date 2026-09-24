import type { SessionSummary } from "@zcode/shared/project-workspaces";
import { Circle, CircleAlert, CircleCheck, CircleHelp, LoaderCircle } from "lucide-react";
import { labels, type SidebarLocale } from "./labels.js";

export function SessionStatusIcon({
  summary,
  locale,
}: {
  summary: SessionSummary;
  locale: SidebarLocale;
}) {
  const l = labels[locale];
  const status =
    summary.freshness !== "live"
      ? l[summary.freshness]
      : summary.activity === "waiting"
        ? l.waiting
        : summary.lastTurn === "failed"
          ? l.failed
          : summary.activity === "running"
            ? l.running
            : summary.activity === "starting"
              ? l.starting
              : summary.activity === "cancelling"
                ? l.cancelling
                : summary.activity === "unknown"
                  ? l.unknown
                  : summary.unread
                    ? l.unread
                    : l.idle;
  const Icon =
    summary.freshness !== "live" || summary.activity === "unknown"
      ? CircleHelp
      : summary.activity === "waiting" || summary.lastTurn === "failed"
        ? CircleAlert
        : summary.activity === "running" ||
            summary.activity === "starting" ||
            summary.activity === "cancelling"
          ? LoaderCircle
          : summary.unread
            ? CircleCheck
            : Circle;
  const color =
    summary.freshness !== "live"
      ? "text-foreground-subtlest"
      : summary.activity === "waiting"
        ? "text-interaction-confirmation-foreground"
        : summary.lastTurn === "failed"
          ? "text-destructive"
          : summary.activity === "running"
            ? "text-warning"
            : "text-foreground-subtle";
  return (
    <span role="img" aria-label={status} title={status}>
      <Icon className={`size-4 ${color}`} aria-hidden="true" />
    </span>
  );
}
