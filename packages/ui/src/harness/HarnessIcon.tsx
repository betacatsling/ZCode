import { BotIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  resolveHarnessIcon,
  staticHarnessAssetSchema,
  type HarnessManifest,
  type StaticHarnessAsset,
} from "@zcode/shared/agent-host";

const HARNESS_ICON_CACHE_LIMIT = 16;
const harnessIconCache = new Map<string, string>();

export type HarnessAssetLoader = (
  assetId: string,
) => Promise<StaticHarnessAsset | null | undefined>;

function rememberHarnessAsset(assetId: string, source: string): void {
  harnessIconCache.delete(assetId);
  harnessIconCache.set(assetId, source);
  if (harnessIconCache.size > HARNESS_ICON_CACHE_LIMIT) {
    const oldest = harnessIconCache.keys().next().value;
    if (oldest) harnessIconCache.delete(oldest);
  }
}

export function HarnessIcon({
  manifest,
  label,
  appearance,
  className = "size-4",
  loadAsset,
}: {
  manifest?: HarnessManifest;
  label: string;
  appearance: "light" | "dark";
  className?: string;
  loadAsset?: HarnessAssetLoader;
}) {
  const resolution = resolveHarnessIcon(manifest, appearance);
  const assetId = resolution.kind === "asset" ? resolution.assetId : null;
  const [loaded, setLoaded] = useState<{ assetId: string; source: string } | null>(() => {
    const cached = assetId ? harnessIconCache.get(assetId) : undefined;
    return cached && assetId ? { assetId, source: cached } : null;
  });
  const source = assetId
    ? (harnessIconCache.get(assetId) ?? (loaded?.assetId === assetId ? loaded.source : undefined))
    : undefined;

  useEffect(() => {
    if (!assetId || !loadAsset || harnessIconCache.has(assetId)) return;
    let current = true;
    void loadAsset(assetId)
      .then((candidate) => {
        if (!current || !candidate) return;
        const parsed = staticHarnessAssetSchema.safeParse(candidate);
        if (!parsed.success || parsed.data.assetId !== assetId) return;
        const dataUrl = `data:${parsed.data.mediaType};charset=utf-8,${encodeURIComponent(parsed.data.content)}`;
        rememberHarnessAsset(assetId, dataUrl);
        setLoaded({ assetId, source: dataUrl });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [assetId, loadAsset]);

  if (source) {
    return (
      <img
        src={source}
        alt=""
        aria-hidden="true"
        data-harness-icon-id={manifest?.id}
        data-harness-asset-id={assetId ?? undefined}
        className={`shrink-0 object-contain ${className}`}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      data-harness-icon-id={manifest?.id}
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-accent text-foreground-subtle ${className}`}
    >
      {resolution.kind === "fallback" && resolution.fallback === "initials" ? (
        <span className="text-ui-xs font-medium">{label.trim().slice(0, 1).toUpperCase()}</span>
      ) : (
        <BotIcon aria-hidden="true" className="size-3.5" />
      )}
    </span>
  );
}
