import { Button } from "@/components/ui/button.js";

export interface ModelBindingOption {
  id: string;
  label: string;
  kind: "host-managed" | "harness-managed";
}

export function ModelBindingSelector({
  options,
  value,
  label,
  kindLabel,
  onChange,
}: {
  options: readonly ModelBindingOption[];
  value: string | null;
  label: string;
  kindLabel: (kind: ModelBindingOption["kind"]) => string;
  onChange: (modelId: string) => void;
}) {
  return (
    <div role="listbox" aria-label={label} className="flex flex-col gap-0.5" data-model-selector="true">
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Button
            key={option.id}
            type="button"
            role="option"
            aria-selected={selected}
            variant="ghost"
            onClick={() => onChange(option.id)}
            data-model-option={option.id}
            data-model-kind={option.kind}
            className="min-h-9 w-full justify-start gap-2 px-2 text-ui-sm md:min-h-8"
          >
            <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">{kindLabel(option.kind)}</span>
          </Button>
        );
      })}
    </div>
  );
}
