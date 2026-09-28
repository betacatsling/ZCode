import type { HarnessDirectoryEntry } from "@zcode/shared/agent-host";
import { HarnessIcon, type HarnessAssetLoader } from "./HarnessIcon.js";

export function HarnessBadge({
  entry,
  appearance,
  loadAsset,
}: {
  entry?: HarnessDirectoryEntry;
  appearance: "light" | "dark";
  loadAsset?: HarnessAssetLoader;
}) {
  if (!entry) return null;
  return (
    <span
      data-harness-badge={entry.manifest.id}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-ui-sm text-foreground-subtle"
    >
      <HarnessIcon
        manifest={entry.manifest}
        label={entry.manifest.name}
        appearance={appearance}
        loadAsset={loadAsset}
        className="size-4"
      />
      <span className="truncate">{entry.manifest.name}</span>
    </span>
  );
}
