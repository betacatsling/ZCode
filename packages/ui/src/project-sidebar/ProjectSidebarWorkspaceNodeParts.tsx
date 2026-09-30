import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import type {
  HarnessManifest,
  SidebarSessionRow,
  SidebarWorkspaceNode,
} from "@zcode/shared/agent-host";
import { HarnessIcon, type HarnessAssetLoader } from "@/harness/HarnessIcon.js";
import { SessionStatusIcon } from "./SessionStatusIcon.js";
import { cn } from "@/components/lib/utils.js";

export function HeadLabel({ workspace }: { workspace: SidebarWorkspaceNode }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="truncate text-ui-xs text-foreground-subtlest">
      {workspace.head?.kind === "branch"
        ? workspace.head.ref
        : workspace.head?.kind === "detached"
          ? `${intl.formatMessage({ id: "projectSidebar.detachedHead" })} ${workspace.head.oid.slice(0, 8)}`
          : intl.formatMessage({ id: "projectSidebar.needsVerification" })}
    </span>
  );
}

export function SessionRow({
  row,
  selectable,
  reason,
  onSelect,
  dataOwnerKind,
  dataOwnerLocatorAvailable,
  targetId,
  manifest,
  appearance,
  loadAsset,
}: {
  row: SidebarSessionRow;
  selectable: boolean;
  reason: string;
  onSelect: () => void;
  dataOwnerKind?: "native-v4" | "agent-host";
  dataOwnerLocatorAvailable?: boolean;
  targetId: string | null;
  manifest?: HarnessManifest;
  appearance: "light" | "dark";
  loadAsset?: HarnessAssetLoader;
}) {
  const { intl, locale } = useZCodeIntl();
  const updatedAt = row.updatedAt > 0 ? new Date(row.updatedAt) : null;
  const updateText = updatedAt
    ? intl.formatMessage(
        { id: "projectSidebar.updatedAt" },
        {
          time: new Intl.DateTimeFormat(locale, {
            dateStyle: "short",
            timeStyle: "short",
          }).format(updatedAt),
        },
      )
    : null;
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={!selectable}
      title={selectable ? (updateText ? `${row.title} · ${updateText}` : row.title) : reason}
      aria-label={selectable ? row.title : `${row.title}: ${reason}`}
      onClick={onSelect}
      data-project-sidebar-session={row.sessionId}
      data-project-sidebar-owner-kind={dataOwnerKind}
      data-project-sidebar-owner-locator-available={
        dataOwnerLocatorAvailable === undefined ? undefined : String(dataOwnerLocatorAvailable)
      }
      data-project-sidebar-target={targetId ?? "legacy"}
      className={cn(
        "min-h-8 w-full justify-start gap-2 rounded-md px-2 text-left text-ui-sm",
        selectable ? "text-foreground" : "cursor-not-allowed text-foreground-subtlest",
      )}
    >
      <SessionStatusIcon row={row} />
      <HarnessIcon
        manifest={manifest}
        label={manifest?.name ?? row.harnessName}
        appearance={appearance}
        className="size-4"
        loadAsset={loadAsset}
      />
      <span
        className="min-w-0 flex-1 truncate"
        data-harness-name={manifest?.name ?? row.harnessName}
      >
        {row.title}
      </span>
      {updateText ? (
        <time
          dateTime={updatedAt?.toISOString()}
          title={updateText}
          className="shrink-0 text-ui-xs text-foreground-subtlest"
        >
          {new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(updatedAt!)}
        </time>
      ) : null}
      {row.unread ? (
        <span
          aria-label={intl.formatMessage({ id: "projectSidebar.unread" })}
          className="size-1.5 rounded-full bg-brand"
        />
      ) : null}
    </Button>
  );
}
