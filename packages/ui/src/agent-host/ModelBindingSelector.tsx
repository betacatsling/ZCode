import type { ModelBindingRequest } from "@zcode/shared/agent-host";
import { labels, type SidebarLocale } from "./labels.js";

/** Options are supplied by the host planner; UI never guesses provider availability or silently defaults. */
export function ModelBindingSelector({
  options,
  index,
  onChange,
  locale,
}: {
  options: readonly { label: string; binding: ModelBindingRequest }[];
  index: number;
  onChange: (index: number) => void;
  locale: SidebarLocale;
}) {
  return (
    <label className="block text-ui-sm text-foreground-subtle">
      {labels[locale].model}
      <select
        className="mt-1 h-8 w-full rounded-lg border border-input-border bg-input px-2 text-ui-base text-foreground"
        value={index}
        onChange={(event) => onChange(Number(event.target.value))}
        required
      >
        {options.length === 0 ? (
          <option value={-1}>{labels[locale].unavailable}</option>
        ) : (
          options.map((option, position) => (
            <option key={`${option.label}-${position}`} value={position}>
              {option.label}
            </option>
          ))
        )}
      </select>
    </label>
  );
}
