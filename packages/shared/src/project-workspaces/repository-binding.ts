import { z } from "zod";
import { pathSchema, stableIdSchema } from "./ids.js";

/**
 * Internal repository instance on one execution target.
 * `gitCommonDir` locates the instance; it is not a permanent id.
 * The same path on another target is a different binding.
 */
export const repositoryBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stableIdSchema,
  projectId: stableIdSchema,
  executionTargetId: stableIdSchema,
  gitCommonDir: pathSchema,
});
export type RepositoryBinding = z.infer<typeof repositoryBindingSchema>;
