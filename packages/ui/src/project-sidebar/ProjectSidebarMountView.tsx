import React, { useState } from "react";
import type { ReactNode } from "react";

export function ProjectSidebarMountView({
  loadState,
  fallback,
  unavailableReason,
  legacySupplement,
  legacySummary,
  children,
}: {
  loadState: {
    status: "loading" | "unavailable" | "ready" | "refreshing";
    reason?: string;
    model?: { snapshot: { projects: readonly unknown[] } };
  };
  fallback: ReactNode;
  unavailableReason?: ReactNode;
  legacySupplement?: ReactNode;
  legacySummary?: ReactNode;
  children: ReactNode | ((openLegacyHistory: () => void) => ReactNode);
}) {
  const [legacyHistoryOpen, setLegacyHistoryOpen] = useState(false);
  const openLegacyHistory = () => setLegacyHistoryOpen(true);
  const resolvedChildren = typeof children === "function" ? children(openLegacyHistory) : children;
  if ((loadState.status !== "ready" && loadState.status !== "refreshing") || !loadState.model) {
    return loadState.status === "unavailable" && unavailableReason ? (
      <>
        {unavailableReason}
        {fallback}
      </>
    ) : (
      fallback
    );
  }
  if (loadState.model.snapshot.projects.length === 0) {
    return (
      <>
        {resolvedChildren}
        <div data-project-sidebar-empty-catalog-legacy="true">{fallback}</div>
      </>
    );
  }
  return (
    <>
      {resolvedChildren}
      {legacySupplement ? (
        <details
          id="project-sidebar-legacy-compat"
          open={legacyHistoryOpen}
          data-project-sidebar-legacy-compat="true"
          className="mt-2 border-t border-border pt-1"
          onToggle={(event) => setLegacyHistoryOpen(event.currentTarget.open)}
        >
          <summary className="min-h-8 cursor-pointer px-1 py-1 text-ui-sm text-foreground-subtle">
            {legacySummary}
          </summary>
          <div data-project-sidebar-legacy-content="true">{legacySupplement}</div>
        </details>
      ) : null}
    </>
  );
}
