import { z } from "zod";

/** Opaque IDs from the trusted asset service, never URL, filesystem path or inline markup. */
export const iconAssetIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}:[a-z0-9][a-z0-9_-]{0,127}$/);
export const harnessIconSchema = z.strictObject({
  light: iconAssetIdSchema.optional(),
  dark: iconAssetIdSchema.optional(),
});
export const harnessManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(128),
  adapterVersion: z.string().trim().min(1).max(128),
  icon: harnessIconSchema.optional(),
});
export type HarnessManifest = z.infer<typeof harnessManifestSchema>;
/** Inspection/session capabilities, not this metadata, decide target availability. */
export const harnessCatalogEntrySchema = z
  .strictObject({
    manifest: harnessManifestSchema,
    availability: z.enum(["supported", "unsupported", "experimental", "unknown"]),
    reason: z.string().trim().min(1).optional(),
  })
  .superRefine((entry, context) => {
    if (entry.availability !== "supported" && !entry.reason)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "unavailable or unverified harness needs a reason",
      });
  });
export type HarnessCatalogEntry = z.infer<typeof harnessCatalogEntrySchema>;
