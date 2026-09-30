import { z } from "zod";
import { stableIdSchema } from "./ids.js";

/**
 * Catalog-owned project metadata. Closing a window does not remove the project.
 * `defaultWorkspaceId` is the preferred entry, distinct from the main worktree flag.
 */
export const projectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stableIdSchema,
  name: z.string().trim().min(1).max(256),
  iconAssetId: stableIdSchema.optional(),
  defaultWorkspaceId: stableIdSchema.optional(),
  /** Target half of a scoped default; absent on legacy unscoped defaults. */
  defaultWorkspaceTargetId: stableIdSchema.optional(),
});
export type Project = z.infer<typeof projectSchema>;
