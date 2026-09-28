import { z } from "zod";

const stableIdSchema = z.string().trim().min(1).max(256);
const sortOrderSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

/** Exact schemaVersion 1 envelope accepted only at the migration boundary. */
const legacyProjectSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: stableIdSchema,
  name: z.string().trim().min(1).max(256),
  iconAssetId: stableIdSchema.optional(),
  defaultWorkspaceId: stableIdSchema.optional(),
});

const legacyProjectCatalogProjectSchema = legacyProjectSchema.extend({
  workspaceIds: z.array(stableIdSchema).max(10_000),
  pinned: z.boolean(),
  sortOrder: sortOrderSchema,
});

export const projectCatalogFileV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projects: z.array(legacyProjectCatalogProjectSchema).max(10_000),
  })
  .superRefine((file, context) => {
    const projectIds = new Set<string>();
    const workspaceOwners = new Map<string, string>();
    for (const [projectIndex, project] of file.projects.entries()) {
      if (projectIds.has(project.id)) {
        context.addIssue({
          code: "custom",
          path: ["projects", projectIndex, "id"],
          message: `duplicate-project-id:${project.id}`,
        });
      }
      projectIds.add(project.id);
      const workspaceIds = new Set<string>();
      for (const [workspaceIndex, workspaceId] of project.workspaceIds.entries()) {
        if (workspaceIds.has(workspaceId)) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectIndex, "workspaceIds", workspaceIndex],
            message: `duplicate-workspace-reference:${workspaceId}`,
          });
        }
        workspaceIds.add(workspaceId);
        const previousOwner = workspaceOwners.get(workspaceId);
        if (previousOwner && previousOwner !== project.id) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectIndex, "workspaceIds", workspaceIndex],
            message: `workspace-reference-owned-by:${previousOwner}`,
          });
        }
        workspaceOwners.set(workspaceId, project.id);
      }
      if (project.defaultWorkspaceId && !workspaceIds.has(project.defaultWorkspaceId)) {
        context.addIssue({
          code: "custom",
          path: ["projects", projectIndex, "defaultWorkspaceId"],
          message: `invalid-default-workspace:${project.defaultWorkspaceId}`,
        });
      }
    }
  });
