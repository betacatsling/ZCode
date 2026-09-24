import { harnessManifestSchema, type HarnessManifest } from "@zcode/shared/agent-host";
import { AcpHarnessAdapter, type TrustedAcpProfile } from "./acpHarnessAdapter.js";

/** Only an explicitly trusted composition root supplies this factory; no repository manifest code loading. */
export function createTrustedAcpFactory(
  manifest: HarnessManifest,
  profile: TrustedAcpProfile,
): () => AcpHarnessAdapter {
  const trusted = harnessManifestSchema.parse(manifest);
  if (trusted.id !== profile.id || trusted.adapterVersion !== profile.version)
    throw new Error("ACP trusted manifest/profile identity or version mismatch");
  return () => new AcpHarnessAdapter(profile);
}
