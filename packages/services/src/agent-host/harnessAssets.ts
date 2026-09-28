import {
  staticAssetIdSchema,
  staticHarnessAssetSchema,
  type StaticHarnessAsset,
} from "@zcode/shared/agent-host";

const ZCODE_LIGHT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#fff"/><path d="M16 18h33L21 47h15l-8 10h20V46H31l18-28H16z" fill="#111"/></svg>`;
const ZCODE_DARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#111"/><path d="M16 18h33L21 47h15l-8 10h20V46H31l18-28H16z" fill="#fff"/></svg>`;
const PI_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="#e48a7a" d="M0 0h8v8H0zM8 0h8v8H8zM16 0h8v8h-8zM16 8h8v8h-8z"/><path fill="#4f8eb3" d="M0 8h8v8H0zM0 16h8v8H0zM8 16h8v8H8zM0 24h8v8H0z"/><path fill="#eab65d" d="M24 16h8v8h-8zM24 24h8v8h-8z"/></svg>`;

const STATIC_HARNESS_ASSETS: Readonly<Record<string, string>> = {
  "zcode-light": ZCODE_LIGHT,
  "zcode-dark": ZCODE_DARK,
  "pi-light": PI_MARK,
  "pi-dark": PI_MARK,
};

/** Exact allowlist lookup: IDs never become paths, URLs, or dynamic module imports. */
export function readHarnessStaticAsset(assetId: string): StaticHarnessAsset | null {
  const parsedId = staticAssetIdSchema.safeParse(assetId);
  if (!parsedId.success) return null;
  const content = STATIC_HARNESS_ASSETS[parsedId.data];
  if (!content) return null;
  return staticHarnessAssetSchema.parse({
    assetId: parsedId.data,
    mediaType: "image/svg+xml",
    content,
  });
}
