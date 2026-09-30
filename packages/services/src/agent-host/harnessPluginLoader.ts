import { harnessPluginManifestSchema, type HarnessPluginManifest } from "@zcode/shared/agent-host";
import type { HarnessAdapter, HarnessRegistry } from "./harnessRegistry.js";

export interface ExplicitHarnessPlugin {
  readonly manifest: HarnessPluginManifest;
  /** Caller-owned trust bit. A manifest cannot set this itself. */
  readonly trusted: boolean;
  readonly create: () => HarnessAdapter;
}

export interface HarnessPluginLoadResult {
  readonly loaded: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: "untrusted" | "disabled" }[];
}

/**
 * Load only plugins the caller both trusts and lists as enabled.
 * Untrusted or disabled factories are not called. This loader does not scan disk.
 */
export function loadExplicitHarnessPlugins(
  registry: HarnessRegistry,
  plugins: readonly ExplicitHarnessPlugin[],
  enabledIds: ReadonlySet<string>,
): HarnessPluginLoadResult {
  const loaded: string[] = [];
  const skipped: { id: string; reason: "untrusted" | "disabled" }[] = [];
  for (const plugin of plugins) {
    const manifest = harnessPluginManifestSchema.parse(plugin.manifest);
    if (!plugin.trusted) {
      skipped.push({ id: manifest.id, reason: "untrusted" });
      continue;
    }
    if (!enabledIds.has(manifest.id)) {
      skipped.push({ id: manifest.id, reason: "disabled" });
      continue;
    }
    const adapter = plugin.create();
    if (adapter.id !== manifest.id || adapter.version !== manifest.adapterVersion) {
      throw new Error(`harness plugin identity mismatch: ${manifest.id}`);
    }
    registry.register(adapter);
    loaded.push(manifest.id);
  }
  return { loaded, skipped };
}
