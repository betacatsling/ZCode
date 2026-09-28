import type {
  HarnessDirectoryEntry as SharedHarnessDirectoryEntry,
  HarnessManifest,
} from "@zcode/shared/agent-host";
import { harnessDirectoryEntrySchema, harnessManifestSchema } from "@zcode/shared/agent-host";
import type { HarnessAdapter, HarnessRegistry } from "./harnessRegistry.js";

export type HarnessDirectoryStatus = "registered" | "unavailable";

export type HarnessDirectoryEntry = SharedHarnessDirectoryEntry;

export interface HarnessDirectory {
  list(): readonly HarnessDirectoryEntry[];
  get(id: string): HarnessDirectoryEntry | undefined;
}

function freezeManifest(manifest: HarnessManifest): HarnessManifest {
  return Object.freeze({
    ...manifest,
    ...(manifest.icon ? { icon: Object.freeze({ ...manifest.icon }) } : {}),
  });
}

export const NATIVE_ZCODE_HARNESS_MANIFEST: HarnessManifest = {
  schemaVersion: 1,
  id: "zcode",
  name: "ZCode",
  adapterVersion: "native-v4",
  icon: { lightAssetId: "zcode-light", darkAssetId: "zcode-dark", fallback: "initials" },
};

export const PI_HARNESS_MANIFEST: HarnessManifest = {
  schemaVersion: 1,
  id: "pi",
  name: "Pi",
  adapterVersion: "0.87.1",
  icon: { lightAssetId: "pi-light", darkAssetId: "pi-dark", fallback: "initials" },
};

export const CODEX_HARNESS_MANIFEST: HarnessManifest = {
  schemaVersion: 1,
  id: "codex",
  name: "Codex CLI",
  adapterVersion: "0.157.1",
  icon: { lightAssetId: "codex-light", darkAssetId: "codex-dark", fallback: "initials" },
};

/** Matches ClaudeHarnessAdapter.id / PINNED_CLAUDE_CLI_VERSION. */
export const CLAUDE_CODE_HARNESS_MANIFEST: HarnessManifest = {
  schemaVersion: 1,
  id: "claude-code",
  name: "Claude Code",
  adapterVersion: "2.1.263",
  icon: {
    lightAssetId: "claude-code-light",
    darkAssetId: "claude-code-dark",
    fallback: "initials",
  },
};

/** Registered Devin CLI manifest; keep adapterVersion in sync with that adapter. */
export const DEVIN_HARNESS_MANIFEST: HarnessManifest = {
  schemaVersion: 1,
  id: "devin",
  name: "Devin CLI",
  adapterVersion: "0.1.0",
  icon: { lightAssetId: "devin-light", darkAssetId: "devin-dark", fallback: "initials" },
};

export const DEFAULT_HOST_HARNESS_MANIFESTS: readonly HarnessManifest[] = [
  NATIVE_ZCODE_HARNESS_MANIFEST,
  PI_HARNESS_MANIFEST,
  CODEX_HARNESS_MANIFEST,
  CLAUDE_CODE_HARNESS_MANIFEST,
  DEVIN_HARNESS_MANIFEST,
];

/**
 * Additive display directory over the existing executable Registry. It never
 * registers, replaces, or instantiates adapters.
 */
export function createHarnessDirectory(input: {
  registry: Pick<HarnessRegistry, "list">;
  manifests: readonly HarnessManifest[];
  nativeManifestIds?: readonly string[];
}): HarnessDirectory {
  const manifests = input.manifests.map((manifest) =>
    freezeManifest(harnessManifestSchema.parse(manifest)),
  );
  const byId = new Map<string, HarnessManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) throw new Error(`duplicate harness manifest: ${manifest.id}`);
    byId.set(manifest.id, manifest);
  }
  const adapters = new Map<string, HarnessAdapter>();
  for (const adapter of input.registry.list()) {
    if (adapters.has(adapter.id)) throw new Error(`duplicate harness adapter: ${adapter.id}`);
    adapters.set(adapter.id, adapter);
  }
  const entries = manifests.map((manifest): HarnessDirectoryEntry => {
    const adapter = adapters.get(manifest.id);
    if (adapter && adapter.version !== manifest.adapterVersion) {
      throw new Error(`harness manifest version mismatch: ${manifest.id}`);
    }
    return Object.freeze({
      manifest,
      status:
        adapter || input.nativeManifestIds?.includes(manifest.id) ? "registered" : "unavailable",
      source: input.nativeManifestIds?.includes(manifest.id) ? "native" : "external",
    });
  });
  entries.forEach((entry) => harnessDirectoryEntrySchema.parse(entry));
  const frozenEntries = Object.freeze(entries);
  return {
    list: () => frozenEntries,
    get: (id) =>
      byId.has(id) ? frozenEntries.find((entry) => entry.manifest.id === id) : undefined,
  };
}

export function createHostHarnessDirectory(input: {
  registry: Pick<HarnessRegistry, "list">;
  manifests?: readonly HarnessManifest[];
}): HarnessDirectory {
  const manifests = input.manifests ?? DEFAULT_HOST_HARNESS_MANIFESTS;
  return createHarnessDirectory({
    registry: input.registry,
    manifests,
    nativeManifestIds: [NATIVE_ZCODE_HARNESS_MANIFEST.id],
  });
}
