import { z } from "zod";

const stableDirectoryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** Opaque, host-approved asset IDs; paths, URLs, and executable content are invalid. */
export const staticAssetIdSchema = stableDirectoryIdSchema;
export type StaticAssetId = z.infer<typeof staticAssetIdSchema>;

export const harnessIconDescriptorSchema = z.strictObject({
  lightAssetId: staticAssetIdSchema.optional(),
  darkAssetId: staticAssetIdSchema.optional(),
  fallback: z.enum(["generic", "initials"]).default("generic"),
});
export type HarnessIconDescriptor = z.infer<typeof harnessIconDescriptorSchema>;

export const harnessManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stableDirectoryIdSchema,
  name: z.string().trim().min(1).max(256),
  adapterVersion: z.string().trim().min(1).max(128),
  icon: harnessIconDescriptorSchema.optional(),
});
export type HarnessManifest = z.infer<typeof harnessManifestSchema>;

export const harnessDirectoryEntryStatusSchema = z.enum(["registered", "unavailable"]);
export type HarnessDirectoryEntryStatus = z.infer<typeof harnessDirectoryEntryStatusSchema>;

export const harnessDirectoryEntrySchema = z.strictObject({
  manifest: harnessManifestSchema,
  status: harnessDirectoryEntryStatusSchema,
  source: z.enum(["native", "external"]).optional(),
});
export type HarnessDirectoryEntry = z.infer<typeof harnessDirectoryEntrySchema>;

export const harnessDirectorySnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  targetId: z.string().trim().min(1).max(256),
  status: z.enum(["available", "unavailable", "unknown"]),
  entries: z.array(harnessDirectoryEntrySchema),
});
export type HarnessDirectorySnapshot = z.infer<typeof harnessDirectorySnapshotSchema>;

export const harnessIconResolutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("asset"), assetId: staticAssetIdSchema }),
  z.strictObject({
    kind: z.literal("fallback"),
    fallback: z.enum(["generic", "initials"]),
  }),
]);
export type HarnessIconResolution = z.infer<typeof harnessIconResolutionSchema>;

const SAFE_STATIC_SVG = /^<svg(?:\s|>)[\s\S]*<\/svg>$/i;
const ACTIVE_SVG_MARKUP = /<\/?(?:script|foreignObject|iframe|object|embed|animate|set)\b/i;
const ACTIVE_SVG_ATTRIBUTES = /\bon[a-z]+\s*=|\b(?:href|xlink:href|style)\s*=|url\s*\(/i;
const SVG_DECLARATIONS = /<!DOCTYPE|<!ENTITY|<\?xml/i;

/** Small static SVG DTO. Only inline geometry is accepted; scripts and external references are not. */
export const staticHarnessAssetSchema = z
  .strictObject({
    assetId: staticAssetIdSchema,
    mediaType: z.literal("image/svg+xml"),
    content: z.string().min(1).max(32 * 1024),
  })
  .superRefine((asset, context) => {
    if (
      !SAFE_STATIC_SVG.test(asset.content.trim()) ||
      ACTIVE_SVG_MARKUP.test(asset.content) ||
      ACTIVE_SVG_ATTRIBUTES.test(asset.content) ||
      SVG_DECLARATIONS.test(asset.content)
    ) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "static Harness SVG must contain inline, non-executable geometry only",
      });
    }
  });
export type StaticHarnessAsset = z.infer<typeof staticHarnessAssetSchema>;

/** Resolve only a validated static asset ID; missing/unknown metadata stays a safe fallback. */
export function resolveHarnessIcon(
  manifest: HarnessManifest | undefined,
  appearance: "light" | "dark",
): HarnessIconResolution {
  const descriptor = manifest?.icon;
  const assetId =
    appearance === "dark"
      ? (descriptor?.darkAssetId ?? descriptor?.lightAssetId)
      : (descriptor?.lightAssetId ?? descriptor?.darkAssetId);
  return assetId
    ? { kind: "asset", assetId }
    : { kind: "fallback", fallback: descriptor?.fallback ?? "generic" };
}
