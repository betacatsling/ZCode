import {
  staticAssetIdSchema,
  staticHarnessAssetSchema,
  type StaticHarnessAsset,
} from "@zcode/shared/agent-host";

/**
 * UI-local StaticHarnessAsset fallbacks keyed by Host asset IDs.
 *
 * The Harness Picker / sidebar never hardcodes which harnesses exist: that list
 * comes from `IAgentHostService.getDirectory()`. These entries only supply a
 * safe image when Host `getHarnessAsset` returns null for a known asset ID
 * already declared on a manifest (for example before licensed brand art lands
 * in `packages/services/src/agent-host/harnessAssets.ts`).
 *
 * Unknown asset IDs stay null so HarnessIcon can use its generic/initials path.
 * Do not turn this map into a harness directory or Picker source of truth.
 */

type LocalFallback = {
  readonly letter: string;
};

/** Asset IDs referenced by DEFAULT Host manifests that may lack Host SVG yet. */
const LOCAL_INITIALS_FALLBACKS: Readonly<Record<string, LocalFallback>> = {
  "pi-light": { letter: "P" },
  "pi-dark": { letter: "P" },
  "codex-light": { letter: "C" },
  "codex-dark": { letter: "C" },
  "claude-code-light": { letter: "C" },
  "claude-code-dark": { letter: "C" },
  "devin-light": { letter: "D" },
  "devin-dark": { letter: "D" },
};

function initialsSvg(letter: string, appearance: "light" | "dark"): string {
  const background = appearance === "dark" ? "#111111" : "#ffffff";
  const foreground = appearance === "dark" ? "#ffffff" : "#111111";
  const safeLetter = letter.trim().slice(0, 1).toUpperCase() || "?";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${background}"/><text x="32" y="42" text-anchor="middle" font-family="system-ui,sans-serif" font-size="28" font-weight="600" fill="${foreground}">${safeLetter}</text></svg>`;
}

function appearanceForAssetId(assetId: string): "light" | "dark" {
  return assetId.endsWith("-dark") ? "dark" : "light";
}

/**
 * Exact allowlist lookup for UI-local SVG fallbacks. IDs are never interpreted
 * as paths, URLs, or dynamic imports.
 */
export function readProjectSidebarHarnessStaticAsset(
  assetId: string,
): StaticHarnessAsset | null {
  const parsedId = staticAssetIdSchema.safeParse(assetId);
  if (!parsedId.success) return null;
  const fallback = LOCAL_INITIALS_FALLBACKS[parsedId.data];
  if (!fallback) return null;
  return staticHarnessAssetSchema.parse({
    assetId: parsedId.data,
    mediaType: "image/svg+xml",
    content: initialsSvg(fallback.letter, appearanceForAssetId(parsedId.data)),
  });
}

/**
 * Prefer Host-served assets; only then apply the UI-local initials fallback.
 * Callers still pass the full Host directory into HarnessPicker unchanged.
 */
export async function loadHarnessAssetWithLocalFallback(
  loadFromHost: (assetId: string) => Promise<StaticHarnessAsset | null | undefined>,
  assetId: string,
): Promise<StaticHarnessAsset | null> {
  try {
    const fromHost = await loadFromHost(assetId);
    if (fromHost) return fromHost;
  } catch {
    // Host miss or transport error → local fallback below.
  }
  return readProjectSidebarHarnessStaticAsset(assetId);
}
