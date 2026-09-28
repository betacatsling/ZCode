import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { HarnessDirectoryEntry } from "@zcode/shared/agent-host";
import { HarnessIcon, type HarnessAssetLoader } from "./HarnessIcon.js";

export function HarnessPicker({
  entries,
  value,
  appearance,
  loadAsset,
  onValueChange,
  disabled = false,
}: {
  entries: readonly HarnessDirectoryEntry[];
  value: string | null;
  appearance: "light" | "dark";
  loadAsset?: HarnessAssetLoader;
  onValueChange: (harnessId: string) => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const selected = entries.find((entry) => entry.manifest.id === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={intl.formatMessage({ id: "projectSidebar.chooseHarness" })}
          aria-haspopup="menu"
          data-harness-picker="true"
          className="min-h-9 w-full justify-between gap-2 text-left text-ui-sm"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <HarnessIcon
                manifest={selected.manifest}
                label={selected.manifest.name}
                appearance={appearance}
                loadAsset={loadAsset}
                className="size-4"
              />
            ) : null}
            <span className="truncate">
              {selected?.manifest.name ?? intl.formatMessage({ id: "projectSidebar.chooseHarness" })}
            </span>
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onValueChange}>
          {entries.map((entry) => {
            const available = entry.status === "registered";
            return (
              <DropdownMenuRadioItem
                key={entry.manifest.id}
                value={entry.manifest.id}
                disabled={!available}
                data-harness-choice={entry.manifest.id}
                className="min-h-9 gap-2 text-ui-sm"
              >
                <HarnessIcon
                  manifest={entry.manifest}
                  label={entry.manifest.name}
                  appearance={appearance}
                  loadAsset={loadAsset}
                  className="size-4"
                />
                <span className="min-w-0 flex-1 truncate">{entry.manifest.name}</span>
                {!available ? (
                  <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                    {intl.formatMessage({ id: "projectSidebar.harnessUnavailable" })}
                  </span>
                ) : null}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
