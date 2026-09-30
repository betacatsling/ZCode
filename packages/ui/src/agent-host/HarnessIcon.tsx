import { BotIcon } from "lucide-react";

export interface HarnessDirectoryEntry {
  harnessId: string;
  name: string;
  lightAssetId?: string;
  darkAssetId?: string;
  fallback: "generic" | "initials";
}

export interface ResolvedHarnessIcon {
  harnessId: string;
  name: string;
  known: boolean;
  assetId?: string;
  fallback: "generic" | "initials";
}

const ACTIVE_SVG =
  /<\s*(?:script|foreignObject|iframe|object|embed|animate|set)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|url\s*\(|<!DOCTYPE|<!ENTITY|<\?xml/i;

/**
 * 只接受调用方已经拿到的静态 SVG data URL。
 * 外部地址、脚本和事件属性一律拒绝，避免按行请求 logo 或执行资源。
 */
export function acceptHarnessAssetSource(source: string | undefined): string | null {
  if (!source) return null;
  const trimmed = source.trim();
  if (/^(?:https?:|javascript:|file:|blob:)/i.test(trimmed)) return null;
  if (!trimmed.toLowerCase().startsWith("data:image/svg+xml")) return null;
  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;
  const meta = trimmed.slice(0, comma);
  const payload = trimmed.slice(comma + 1);
  let text: string;
  try {
    text = /;base64/i.test(meta) ? atob(payload) : decodeURIComponent(payload);
  } catch {
    return null;
  }
  const svg = text.trim();
  if (!/^<svg(?:\s|>)/i.test(svg) || !/<\/svg>$/i.test(svg) || ACTIVE_SVG.test(svg)) return null;
  return trimmed;
}

/** 只按 harnessId 查目录。名称或模型文本即使碰巧相同也不选用。 */
export function resolveHarnessDirectoryIcon(
  directory: readonly HarnessDirectoryEntry[],
  harnessId: string,
  appearance: "light" | "dark",
): ResolvedHarnessIcon {
  const entry = directory.find((item) => item.harnessId === harnessId);
  if (!entry) {
    return { harnessId, name: harnessId, known: false, fallback: "initials" };
  }
  const assetId =
    appearance === "dark"
      ? (entry.darkAssetId ?? entry.lightAssetId)
      : (entry.lightAssetId ?? entry.darkAssetId);
  return {
    harnessId,
    name: entry.name,
    known: true,
    assetId,
    fallback: entry.fallback,
  };
}

function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export function HarnessIcon({
  harnessId,
  directory,
  assets,
  appearance,
  className = "size-4",
}: {
  harnessId: string;
  directory: readonly HarnessDirectoryEntry[];
  assets?: Readonly<Record<string, string>>;
  appearance: "light" | "dark";
  className?: string;
}) {
  const resolved = resolveHarnessDirectoryIcon(directory, harnessId, appearance);
  const source = resolved.assetId ? acceptHarnessAssetSource(assets?.[resolved.assetId]) : null;
  if (source) {
    return (
      <img
        src={source}
        alt=""
        aria-hidden="true"
        data-harness-icon="true"
        data-harness-id={resolved.harnessId}
        data-harness-name={resolved.name}
        data-harness-known={resolved.known ? "true" : "false"}
        data-harness-asset-id={resolved.assetId}
        className={`shrink-0 object-contain ${className}`}
      />
    );
  }
  return (
    <span
      aria-label={resolved.name}
      data-harness-icon="true"
      data-harness-id={resolved.harnessId}
      data-harness-name={resolved.name}
      data-harness-known={resolved.known ? "true" : "false"}
      data-harness-fallback={resolved.fallback}
      className={`inline-flex shrink-0 items-center justify-center rounded-md bg-accent text-foreground-subtle ${className}`}
    >
      {resolved.fallback === "initials" ? (
        <span className="text-ui-xs font-medium">{initials(resolved.name)}</span>
      ) : (
        <BotIcon aria-hidden="true" className="size-3.5" />
      )}
    </span>
  );
}
