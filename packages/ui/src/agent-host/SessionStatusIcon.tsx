import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";

export function SessionStatusIcon({
  attention,
  activity,
  freshness,
  recentOutcome,
  label,
  freshnessLabel,
}: {
  attention: "pending" | "error" | "unknown" | "running" | "unread" | "idle";
  activity: "idle" | "starting" | "running" | "waiting" | "cancelling";
  freshness: "live" | "stale" | "offline" | "unknown";
  recentOutcome: "none" | "succeeded" | "failed" | "cancelled" | "unknown";
  label: string;
  freshnessLabel: string;
}) {
  const icon =
    attention === "pending" ? (
      <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5 text-warning" />
    ) : attention === "running" ? (
      <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin text-warning" />
    ) : attention === "error" ? (
      <CircleAlertIcon aria-hidden="true" className="size-3.5 text-destructive" />
    ) : attention === "unknown" ? (
      <CircleHelpIcon aria-hidden="true" className="size-3.5 text-foreground-subtlest" />
    ) : attention === "unread" ? (
      <CircleCheckIcon aria-hidden="true" className="size-3.5 text-success" />
    ) : (
      <CircleDotIcon aria-hidden="true" className="size-3.5 text-foreground-subtle" />
    );
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      data-session-status="true"
      data-attention={attention}
      data-activity={activity}
      data-freshness={freshness}
      data-outcome={recentOutcome}
    >
      <span aria-label={label} className="inline-flex">
        {icon}
      </span>
      {freshness === "live" ? null : (
        <span className="text-ui-xs text-foreground-subtlest">{freshnessLabel}</span>
      )}
    </span>
  );
}
