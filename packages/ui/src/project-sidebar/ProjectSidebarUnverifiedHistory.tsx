import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SessionHierarchyRecord } from "@zcode/shared/agent-host";
import type { ProjectSidebarTargetViewSnapshot, ProjectSidebarViewModel } from "./contract.js";

export function ProjectSidebarUnverifiedHistory({
  model,
  onOpenHistoryRecord,
}: {
  model: ProjectSidebarViewModel;
  onOpenHistoryRecord: (targetId: string, record: SessionHierarchyRecord) => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [waiting, setWaiting] = useState<ReadonlyMap<string, "checking" | "target" | "owner">>(
    new Map(),
  );
  const displayedSessionKeys = new Set(
    model.snapshot.projects.flatMap((project) =>
      project.workspaces.flatMap((workspace) =>
        workspace.sessions.map((session) =>
          JSON.stringify([workspace.targetId, workspace.workspaceId, session.sessionId]),
        ),
      ),
    ),
  );
  const unverifiedSessions = model.source.targets.flatMap((target) =>
    (target.model.source.migration?.records ?? [])
      .filter((record) => {
        if (record.status !== "linked" || !record.workspaceId || !record.harnessId) return true;
        return !displayedSessionKeys.has(
          JSON.stringify([target.targetId, record.workspaceId, record.hierarchySessionId]),
        );
      })
      .map((record) => ({ target, record })),
  );
  if (unverifiedSessions.length === 0) return null;

  const canResolve = (target: ProjectSidebarTargetViewSnapshot, record: SessionHierarchyRecord) => {
    if (
      model.source.targetFreshness.get(target.targetId) !== "live" ||
      record.targetId !== target.targetId
    ) {
      return false;
    }
    if (record.ownerKind === "native-v4") return Boolean(record.workspacePath);
    return Boolean(
      record.workspacePath &&
      record.workspaceId &&
      record.harnessId &&
      (record.ownerAssociation || record.ownerHistoryAssociation),
    );
  };

  return (
    <div
      className="mt-2 border-t border-border pt-2"
      data-project-sidebar-unverified-history="true"
    >
      <p className="px-1 pb-1 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "projectSidebar.unverifiedHistory" })}
      </p>
      {unverifiedSessions.map(({ target, record }) => {
        const key = JSON.stringify([target.targetId, record.hierarchySessionId]);
        const routeable = canResolve(target, record);
        const currentWaiting = waiting.get(key);
        const waitingFor =
          currentWaiting === "target" &&
          model.source.targetFreshness.get(target.targetId) === "live"
            ? undefined
            : currentWaiting;
        const statusText =
          waitingFor && waitingFor !== "checking"
            ? intl.formatMessage({
                id:
                  waitingFor === "target"
                    ? "projectSidebar.historyWaitingTarget"
                    : waitingFor === "owner"
                      ? "projectSidebar.historyNeedsVerification"
                      : "projectSidebar.historyCheckingOwner",
              })
            : !routeable
              ? intl.formatMessage({
                  id:
                    model.source.targetFreshness.get(target.targetId) === "live"
                      ? "projectSidebar.historyNeedsVerification"
                      : "projectSidebar.historyWaitingTarget",
                })
              : "";
        return (
          <div key={key} className="space-y-0.5">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={!routeable || waitingFor === "checking"}
              title={statusText || undefined}
              aria-label={
                statusText
                  ? `${record.title?.trim() || intl.formatMessage({ id: "projectSidebar.legacySession" })}: ${statusText}`
                  : record.title?.trim() ||
                    intl.formatMessage({ id: "projectSidebar.legacySession" })
              }
              onClick={() => {
                if (!routeable) return;
                setWaiting((current) => new Map(current).set(key, "checking"));
                void onOpenHistoryRecord(target.targetId, record).then(
                  (opened) => {
                    setWaiting((current) => {
                      const next = new Map(current);
                      if (opened) next.delete(key);
                      else next.set(key, "owner");
                      return next;
                    });
                  },
                  () => setWaiting((current) => new Map(current).set(key, "owner")),
                );
              }}
              className="min-h-8 w-full justify-start gap-2 px-2 text-left text-ui-sm text-foreground-subtle"
              data-project-sidebar-unverified-session={record.hierarchySessionId}
              data-project-sidebar-target={target.targetId}
              data-project-sidebar-history-owner={record.ownerKind}
            >
              <span className="min-w-0 flex-1 truncate">
                {record.title?.trim() || intl.formatMessage({ id: "projectSidebar.legacySession" })}
              </span>
              <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                {target.targetPresentation.kind === "local"
                  ? intl.formatMessage({ id: "projectSidebar.localTarget" })
                  : (target.targetPresentation.displayName ??
                    intl.formatMessage({ id: "projectSidebar.targetNeedsVerification" }))}
              </span>
            </Button>
            {statusText ? (
              <p role="status" className="px-2 text-ui-xs text-warning">
                {statusText}
              </p>
            ) : waitingFor === "owner" ? (
              <p role="status" className="px-2 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "projectSidebar.historyCheckingOwner" })}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
