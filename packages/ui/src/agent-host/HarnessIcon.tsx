import { useState } from "react";
import type { HarnessCatalogEntry } from "@zcode/shared/agent-host";
import { safeHarnessPngDataUrl, type HarnessAssetDescriptor } from "./harnessAssetResolver.js";

export function safeIconUrl(
  assetId: string | undefined,
  resolveIconAsset: (assetId: string) => string | undefined,
): string | undefined {
  const resolved = assetId ? resolveIconAsset(assetId) : undefined;
  // 即使注入的资源解析器出错，也不允许第三方 URL/协议借图标向外发请求。
  return resolved?.startsWith("/") &&
    !resolved.startsWith("//") &&
    !Array.from(resolved).some((char) => char === "\\" || char.charCodeAt(0) < 32)
    ? resolved
    : undefined;
}

export function HarnessIcon({
  harnessId,
  catalog,
  resolveIconAsset,
  theme = "light",
}: {
  harnessId: string;
  catalog: readonly HarnessCatalogEntry[];
  resolveIconAsset: (assetId: string) => HarnessAssetDescriptor | string | undefined;
  theme?: "light" | "dark";
}) {
  const entry = catalog.find((item) => item.manifest.id === harnessId);
  const name = entry?.manifest.name ?? harnessId;
  const assetId =
    theme === "dark"
      ? (entry?.manifest.icon?.dark ?? entry?.manifest.icon?.light)
      : (entry?.manifest.icon?.light ?? entry?.manifest.icon?.dark);
  // Harness 只能显示已验证的打包 PNG 描述符；旧路径解析器仅供 Project 图标使用。
  const url = safeHarnessPngDataUrl(assetId, resolveIconAsset);
  const [brokenUrl, setBrokenUrl] = useState<string>();
  // 资源缺失/加载失败只显示中性占位，不能误认成另一种 Harness 品牌。
  return (
    <span
      data-testid="harness-icon"
      data-harness={harnessId}
      title={name}
      aria-label={name}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-md bg-surface text-ui-xs font-medium text-foreground-subtle"
    >
      {url && brokenUrl !== url ? (
        <img src={url} alt="" className="size-4 object-contain" onError={() => setBrokenUrl(url)} />
      ) : (
        <span aria-hidden="true">{name.trim().slice(0, 1).toLocaleUpperCase() || "?"}</span>
      )}
    </span>
  );
}
