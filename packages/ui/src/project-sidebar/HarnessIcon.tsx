import { BotIcon } from "lucide-react";
import type { HarnessIconResolution } from "@zcode/shared/agent-host";

export function HarnessIcon({
  resolution,
  label,
  className = "size-4",
  resolveAsset,
}: {
  resolution: HarnessIconResolution;
  label: string;
  className?: string;
  resolveAsset?: (assetId: string) => string | undefined;
}) {
  if (resolution.kind === "asset") {
    const source = resolveAsset?.(resolution.assetId);
    if (source) {
      return <img src={source} alt="" aria-hidden className={className} />;
    }
  }
  return (
    <span
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-accent text-foreground-subtle ${className}`}
    >
      {resolution.kind === "fallback" && resolution.fallback === "initials" ? (
        <span className="text-ui-xs font-medium">{label.trim().slice(0, 1).toUpperCase()}</span>
      ) : (
        <BotIcon aria-hidden className="size-3.5" />
      )}
    </span>
  );
}
