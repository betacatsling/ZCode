import { Button } from "@/components/ui/button.js";
import { HarnessIcon, type HarnessDirectoryEntry } from "./HarnessIcon.js";

export function HarnessSelector({
  directory,
  assets,
  appearance,
  value,
  label,
  onChange,
}: {
  directory: readonly HarnessDirectoryEntry[];
  assets?: Readonly<Record<string, string>>;
  appearance: "light" | "dark";
  value: string | null;
  label: string;
  onChange: (harnessId: string) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={label}
      className="flex flex-col gap-0.5"
      data-harness-selector="true"
    >
      {directory.map((entry) => {
        const selected = entry.harnessId === value;
        return (
          <Button
            key={entry.harnessId}
            type="button"
            role="option"
            aria-selected={selected}
            variant="ghost"
            onClick={() => onChange(entry.harnessId)}
            data-harness-option={entry.harnessId}
            className="min-h-9 w-full justify-start gap-2 px-2 text-ui-sm md:min-h-8"
          >
            <HarnessIcon
              harnessId={entry.harnessId}
              directory={directory}
              assets={assets}
              appearance={appearance}
            />
            <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
          </Button>
        );
      })}
    </div>
  );
}
