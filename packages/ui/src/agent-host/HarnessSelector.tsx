import type { HarnessCatalogEntry } from "@zcode/shared/agent-host";
import type { SidebarIconAsset } from "./harnessAssetResolver.js";
import { HarnessIcon } from "./HarnessIcon.js";
import { CompatibilityStatus } from "./CompatibilityStatus.js";
import { labels, type SidebarLocale } from "./labels.js";

export function HarnessSelector({
  catalog,
  value,
  onChange,
  resolveIconAsset,
  locale,
}: {
  catalog: readonly HarnessCatalogEntry[];
  value: string;
  onChange: (id: string) => void;
  resolveIconAsset: (assetId: string) => SidebarIconAsset | undefined;
  locale: SidebarLocale;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-ui-sm text-foreground-subtle">{labels[locale].harness}</legend>
      {catalog.map((entry) => (
        <label
          key={entry.manifest.id}
          className="flex min-h-8 items-center gap-2 rounded-md px-2 hover:bg-hover"
        >
          <input
            type="radio"
            name="harness"
            value={entry.manifest.id}
            checked={entry.manifest.id === value}
            disabled={entry.availability !== "supported"}
            onChange={() => onChange(entry.manifest.id)}
          />
          <HarnessIcon
            harnessId={entry.manifest.id}
            catalog={catalog}
            resolveIconAsset={resolveIconAsset}
          />
          <span>{entry.manifest.name}</span>
          <CompatibilityStatus entry={entry} locale={locale} />
        </label>
      ))}
    </fieldset>
  );
}
