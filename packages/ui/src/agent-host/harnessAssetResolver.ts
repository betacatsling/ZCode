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
    const bytes = atob(descriptor.base64);
    if (bytes.length < 57 || bytes.length > 256 * 1024 || !bytes.startsWith("\x89PNG\r\n\x1a\n"))
      return undefined;
    const uint32 = (index: number) =>
      bytes.charCodeAt(index) * 0x1000000 +
      (bytes.charCodeAt(index + 1) << 16) +
      (bytes.charCodeAt(index + 2) << 8) +
      bytes.charCodeAt(index + 3);
    let offset = 8;
    let first = true;
    let imageData = false;
    let ended = false;
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) return undefined;
      const length = uint32(offset);
      if (length > bytes.length - offset - 12) return undefined;
      const type = bytes.slice(offset + 4, offset + 8);
      if (first) {
        if (type !== "IHDR" || length !== 13) return undefined;
        const width = uint32(offset + 8);
        const height = uint32(offset + 12);
        if (
          width < 1 ||
          height < 1 ||
          width > 1024 ||
          height > 1024 ||
          bytes.charCodeAt(offset + 16) !== 8 ||
          ![2, 6].includes(bytes.charCodeAt(offset + 17)) ||
          bytes.charCodeAt(offset + 18) !== 0 ||
          bytes.charCodeAt(offset + 19) !== 0 ||
          bytes.charCodeAt(offset + 20) !== 0
        )
          return undefined;
        first = false;
      } else if (type === "IHDR") return undefined;
      if (type === "IDAT") imageData = true;
      offset += length + 12;
      if (type === "IEND") {
        if (length !== 0 || !imageData) return undefined;
        ended = true;
        break;
      }
    }
    // 不能只验 IHDR；被截断的描述符或在 IEND 后拼接的负载必须在设置 img.src 前拒绝。
    if (!ended || offset !== bytes.length) return undefined;
  } catch {
    return undefined;
  }
  return `data:image/png;base64,${descriptor.base64}`;
}
