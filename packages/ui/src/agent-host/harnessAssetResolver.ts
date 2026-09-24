import { iconAssetIdSchema } from "@zcode/shared/agent-host";

/** The Host sends validated packaged raster bytes, not a URL or renderer file path. */
export interface HarnessAssetDescriptor {
  readonly kind: "trusted-png";
  readonly mimeType: "image/png";
  readonly base64: string;
}

export type SidebarIconAsset = HarnessAssetDescriptor | string;

const maxBase64Length = Math.ceil((256 * 1024) / 3) * 4;

export function safeHarnessPngDataUrl(
  assetId: string | undefined,
  resolveIconAsset: (assetId: string) => SidebarIconAsset | undefined,
): string | undefined {
  if (!assetId || !iconAssetIdSchema.safeParse(assetId).success) return undefined;
  let resource: unknown;
  try {
    resource = resolveIconAsset(assetId);
  } catch {
    // 解析器异常只能退回中性占位，不让外部清单决定图标网络请求或崩溃 UI。
    return undefined;
  }
  if (!resource || typeof resource !== "object") return undefined;
  const descriptor = resource as Record<string, unknown>;
  if (
    descriptor.kind !== "trusted-png" ||
    descriptor.mimeType !== "image/png" ||
    typeof descriptor.base64 !== "string" ||
    descriptor.base64.length > maxBase64Length ||
    descriptor.base64.length < 32 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(descriptor.base64)
  )
    return undefined;
  try {
    const header = atob(descriptor.base64.slice(0, 36));
    if (!header.startsWith("\x89PNG\r\n\x1a\n") || header.slice(12, 16) !== "IHDR")
      return undefined;
    const dimension = (index: number) =>
      header.charCodeAt(index) * 0x1000000 +
      (header.charCodeAt(index + 1) << 16) +
      (header.charCodeAt(index + 2) << 8) +
      header.charCodeAt(index + 3);
    const width = dimension(16);
    const height = dimension(20);
    if (width < 1 || height < 1 || width > 1024 || height > 1024) return undefined;
  } catch {
    return undefined;
  }
  return `data:image/png;base64,${descriptor.base64}`;
}
