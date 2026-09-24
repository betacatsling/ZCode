import type { HarnessCatalogEntry } from "@zcode/shared/agent-host";
import { labels, type SidebarLocale } from "./labels.js";

export function CompatibilityStatus({
  entry,
  locale,
}: {
  entry: HarnessCatalogEntry;
  locale: SidebarLocale;
}) {
  return (
    <span
      className={`text-ui-xs ${entry.availability === "supported" ? "text-foreground-subtle" : "text-warning"}`}
      title={entry.reason}
    >
      {entry.availability === "supported"
        ? labels[locale].compatible
        : `${labels[locale].unavailable}: ${entry.reason}`}
    </span>
  );
}
