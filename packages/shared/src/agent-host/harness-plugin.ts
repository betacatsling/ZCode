import { z } from "zod";

/**
 * Trusted manifest metadata only. Execution capabilities come from probe/session,
 * and this object cannot mark itself trusted or enabled.
 */
export const harnessPluginManifestSchema = z.strictObject({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
  adapterVersion: z.string().trim().min(1).max(128),
  iconAssetId: z.string().trim().min(1).max(256).optional(),
});
export type HarnessPluginManifest = z.infer<typeof harnessPluginManifestSchema>;
