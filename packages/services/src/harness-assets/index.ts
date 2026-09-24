import { readFile } from "node:fs/promises";
import { iconAssetIdSchema } from "@zcode/shared/agent-host";

export const MAX_HARNESS_PNG_BYTES = 256 * 1024;

/** Metadata only: runtime adapter registration and availability belong to the Host. */
const trustedManifest = {
  zcode: { id: "builtin:zcode", packagedPath: "assets/zcode.png" },
  pi: { id: "builtin:pi", packagedPath: "assets/pi.png" },
} as const;

/** The only trusted branding inventory; it is display metadata, not an adapter registry. */
export const nativeHarnessAssetMetadata: Readonly<
  Record<string, { icon?: { light: string; dark: string } }>
> = {
  zcode: { icon: { light: trustedManifest.zcode.id, dark: trustedManifest.zcode.id } },
  pi: { icon: { light: trustedManifest.pi.id, dark: trustedManifest.pi.id } },
  codex: {},
  claude: {},
};

/** Paths relative to this module, required by a packaged runtime (no renderer URLs). */
export const harnessAssetPackagePaths: readonly string[] = Object.values(trustedManifest).map(
  ({ packagedPath }) => packagedPath,
);

export interface TrustedPngDescriptor {
  readonly kind: "trusted-png";
  readonly mimeType: "image/png";
  readonly base64: string;
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Reject malformed PNG containers before anything reaches an image decoder. */
export function validateTrustedPng(bytes: Uint8Array): {
  mimeType: "image/png";
  width: number;
  height: number;
} {
  const png = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    png.length < 57 ||
    png.length > MAX_HARNESS_PNG_BYTES ||
    !png.subarray(0, 8).equals(signature)
  ) {
    throw new Error("invalid trusted PNG size or signature");
  }
  let offset = 8;
  let first = true;
  let idat = false;
  let ended = false;
  let width = 0;
  let height = 0;
  while (offset < png.length) {
    if (png.length - offset < 12) throw new Error("truncated PNG chunk");
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) throw new Error("invalid PNG chunk length");
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (!/^[a-zA-Z]{4}$/.test(type)) throw new Error("invalid PNG chunk type");
    if (first) {
      if (type !== "IHDR" || length !== 13) throw new Error("invalid PNG header");
      width = png.readUInt32BE(offset + 8);
      height = png.readUInt32BE(offset + 12);
      if (
        width < 1 ||
        height < 1 ||
        width > 1024 ||
        height > 1024 ||
        png[offset + 16] !== 8 ||
        ![2, 6].includes(png[offset + 17]!) ||
        png[offset + 18] !== 0 ||
        png[offset + 19] !== 0 ||
        png[offset + 20] !== 0
      ) {
        throw new Error("invalid PNG dimensions or encoding");
      }
      first = false;
    } else if (type === "IHDR" || (type === "IEND" && (length !== 0 || !idat))) {
      throw new Error("invalid PNG chunk order");
    }
    if (type === "IDAT") idat = true;
    offset += 12 + length;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== png.length) throw new Error("missing PNG end or trailing data");
  return { mimeType: "image/png", width, height };
}

const packagedAssets: Readonly<Record<string, URL>> = Object.fromEntries(
  Object.values(trustedManifest).map(({ id, packagedPath }) => [
    id,
    new URL(`./${packagedPath}`, import.meta.url),
  ]),
);

/** Static allowlist only; untrusted IDs are never interpreted as paths or fetched URLs. */
export async function resolveHarnessAsset(id: string): Promise<TrustedPngDescriptor | undefined> {
  if (!iconAssetIdSchema.safeParse(id).success) return undefined;
  const resource = Object.hasOwn(packagedAssets, id) ? packagedAssets[id] : undefined;
  if (!resource) return undefined;
  try {
    const bytes = await readFile(resource);
    validateTrustedPng(bytes);
    return { kind: "trusted-png", mimeType: "image/png", base64: bytes.toString("base64") };
  } catch {
    // 打包资源缺失或损坏时不能回退到清单中的 URL/路径，保持中性图标。
    return undefined;
  }
}
