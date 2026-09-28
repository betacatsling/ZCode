import { z } from "zod";
import {
  projectCatalogTargetFreshnessSchema,
  projectRepositoryReferenceSchema,
  projectWorkspaceReferenceSchema,
  projectSchema,
  type ProjectCatalogTargetConnection,
  type ProjectCatalogTargetFreshness,
  type ProjectCatalogTargetSnapshot,
  type ProjectCatalogTargetPresentation,
  type ProjectRepositoryReference,
  type ProjectWorkspaceReference,
} from "@zcode/shared/agent-host";

const stableIdSchema = z.string().trim().min(1).max(256);
const sortOrderSchema = z.number().int().min(-2_147_483_648).max(2_147_483_647);

/** Catalog-owned Project metadata, target references, and user preferences. */
export const projectCatalogProjectSchema = projectSchema
  .extend({
    /** Compatibility list containing only legacy IDs without a proven target. */
    workspaceIds: z.array(stableIdSchema).max(10_000),
    repositoryReferences: z.array(projectRepositoryReferenceSchema).max(10_000),
    workspaceReferences: z.array(projectWorkspaceReferenceSchema).max(50_000),
    pinned: z.boolean(),
    sortOrder: sortOrderSchema,
  })
  .superRefine((project, context) => {
    const legacyReferenceIds = new Set(
      project.workspaceReferences
        .filter((reference) => reference.targetId === null)
        .map((reference) => reference.workspaceId),
    );
    const workspaceIds = new Set(project.workspaceIds);
    if (workspaceIds.size !== project.workspaceIds.length) {
      context.addIssue({
        code: "custom",
        path: ["workspaceIds"],
        message: "duplicate-legacy-workspace-id",
      });
    }
    if (
      legacyReferenceIds.size !== workspaceIds.size ||
      [...legacyReferenceIds].some((workspaceId) => !workspaceIds.has(workspaceId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspaceReferences"],
        message: "legacy-workspace-reference-mismatch",
      });
    }
    if (project.defaultWorkspaceId) {
      const hasDefault = project.defaultWorkspaceTargetId
        ? project.workspaceReferences.some(
            (reference) =>
              reference.targetId === project.defaultWorkspaceTargetId &&
              reference.workspaceId === project.defaultWorkspaceId,
          )
        : workspaceIds.has(project.defaultWorkspaceId);
      if (!hasDefault) {
        context.addIssue({
          code: "custom",
          path: ["defaultWorkspaceId"],
          message: "invalid-default-workspace-reference",
        });
      }
    } else if (project.defaultWorkspaceTargetId) {
      context.addIssue({
        code: "custom",
        path: ["defaultWorkspaceTargetId"],
        message: "default-workspace-target-without-workspace",
      });
    }
    for (const [index, reference] of project.workspaceReferences.entries()) {
      if (reference.projectId !== project.id) {
        context.addIssue({
          code: "custom",
          path: ["workspaceReferences", index, "projectId"],
          message: "workspace-reference-project-mismatch",
        });
      }
    }
    for (const [index, reference] of project.repositoryReferences.entries()) {
      if (reference.projectId !== project.id) {
        context.addIssue({
          code: "custom",
          path: ["repositoryReferences", index, "projectId"],
          message: "repository-reference-project-mismatch",
        });
      }
    }
  });
export type ProjectCatalogProject = z.infer<typeof projectCatalogProjectSchema>;

export const projectCatalogFileSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    projects: z.array(projectCatalogProjectSchema).max(10_000),
    targets: z.array(projectCatalogTargetFreshnessSchema).max(10_000),
  })
  .superRefine((file, context) => {
    const projectIds = new Set<string>();
    const workspaceOwners = new Map<string, string>();
    const repositoryOwners = new Map<string, string>();
    const targetIds = new Set<string>();
    for (const [index, target] of file.targets.entries()) {
      if (targetIds.has(target.targetId)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "targetId"],
          message: `duplicate-target-id:${target.targetId}`,
        });
      }
      targetIds.add(target.targetId);
      if (
        target.freshness === "live" &&
        (target.lastVerifiedAt === null || target.freshnessUpdatedAt === null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "lastVerifiedAt"],
          message: "live-target-requires-verification-time-and-update-time",
        });
      }
    }
    for (const [projectIndex, project] of file.projects.entries()) {
      if (projectIds.has(project.id)) {
        context.addIssue({
          code: "custom",
          path: ["projects", projectIndex, "id"],
          message: `duplicate-project-id:${project.id}`,
        });
      }
      projectIds.add(project.id);
      for (const [referenceIndex, reference] of project.repositoryReferences.entries()) {
        const key = JSON.stringify([reference.targetId, reference.repositoryBindingId]);
        const previousOwner = repositoryOwners.get(key);
        if (previousOwner) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectIndex, "repositoryReferences", referenceIndex],
            message: `repository-reference-owned-by:${previousOwner}`,
          });
        }
        repositoryOwners.set(key, project.id);
        if (!targetIds.has(reference.targetId)) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectIndex, "repositoryReferences", referenceIndex, "targetId"],
            message: `repository-reference-target-missing:${reference.targetId}`,
          });
        }
      }
      for (const [referenceIndex, reference] of project.workspaceReferences.entries()) {
        const key = JSON.stringify([reference.targetId, reference.workspaceId]);
        const previousOwner = workspaceOwners.get(key);
        if (previousOwner) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectIndex, "workspaceReferences", referenceIndex],
            message: `workspace-reference-already-owned-by:${previousOwner}`,
          });
        }
        workspaceOwners.set(key, project.id);
        if (reference.targetId === null) continue;
        if (!targetIds.has(reference.targetId)) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectIndex, "workspaceReferences", referenceIndex, "targetId"],
            message: `workspace-reference-target-missing:${reference.targetId}`,
          });
        }
        if (
          !project.repositoryReferences.some(
            (repository) =>
              repository.targetId === reference.targetId &&
              repository.repositoryBindingId === reference.repositoryBindingId,
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["projects", projectIndex, "workspaceReferences", referenceIndex],
            message: "workspace-reference-repository-not-owned",
          });
        }
      }
    }
  });
export type ProjectCatalogFile = z.infer<typeof projectCatalogFileSchema>;

export const projectCatalogReadModelSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projects: z.array(projectCatalogProjectSchema).max(10_000),
    targets: z.array(projectCatalogTargetFreshnessSchema).max(10_000),
  })
  .superRefine((readModel, context) => {
    const validation = projectCatalogFileSchema.safeParse({
      schemaVersion: 2,
      projects: readModel.projects,
      targets: readModel.targets,
    });
    if (!validation.success) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "invalid-project-catalog-read-model",
      });
    }
  });
export type ProjectCatalogReadModel = z.infer<typeof projectCatalogReadModelSchema>;

export const createProjectInputSchema = z.strictObject({
  id: stableIdSchema,
  name: z.string().trim().min(1).max(256),
  iconAssetId: stableIdSchema.optional(),
  defaultWorkspaceId: stableIdSchema.optional(),
  workspaceIds: z.array(stableIdSchema).max(10_000).optional(),
  pinned: z.boolean().optional(),
  sortOrder: sortOrderSchema.optional(),
});

export const updateProjectPatchSchema = z.strictObject({
  name: z.string().trim().min(1).max(256).optional(),
  iconAssetId: stableIdSchema.nullable().optional(),
  pinned: z.boolean().optional(),
  sortOrder: sortOrderSchema.optional(),
});

export const setWorkspaceRefsRequestSchema = z.strictObject({
  id: stableIdSchema,
  workspaceIds: z.array(stableIdSchema).max(10_000),
  defaultWorkspaceId: stableIdSchema.nullable().optional(),
});

export const setDefaultWorkspaceRefInputSchema = z
  .strictObject({ targetId: stableIdSchema, workspaceId: stableIdSchema })
  .nullable();

export const markTargetFreshnessInputSchema = z.strictObject({
  targetId: stableIdSchema,
  freshness: z.enum(["stale", "offline", "unknown"]),
  observedAt: z.number().int().nonnegative(),
});

export interface CreateProjectInput {
  readonly id: string;
  readonly name: string;
  readonly iconAssetId?: string;
  readonly defaultWorkspaceId?: string;
  readonly workspaceIds?: readonly string[];
  readonly pinned?: boolean;
  readonly sortOrder?: number;
}

export interface UpdateProjectPatch {
  readonly name?: string;
  readonly iconAssetId?: string | null;
  readonly pinned?: boolean;
  readonly sortOrder?: number;
}

export interface ProjectCatalogPersistence {
  read(): Promise<unknown | null>;
  update(mutator: (current: unknown | null) => ProjectCatalogFile): Promise<ProjectCatalogFile>;
}

export interface IProjectCatalogService {
  read(): Promise<ProjectCatalogFile>;
  readWorkspaceCatalog(
    targetConnections?: readonly ProjectCatalogTargetConnection[],
  ): Promise<ProjectCatalogReadModel>;
  createProject(input: CreateProjectInput): Promise<ProjectCatalogProject>;
  updateProject(id: string, patch: UpdateProjectPatch): Promise<ProjectCatalogProject>;
  setWorkspaceRefs(
    id: string,
    workspaceIds: readonly string[],
    defaultWorkspaceId?: string | null,
  ): Promise<ProjectCatalogProject>;
  setDefaultWorkspaceRef(
    id: string,
    reference: { targetId: string; workspaceId: string } | null,
  ): Promise<ProjectCatalogProject>;
  ingestTargetSnapshot(snapshot: ProjectCatalogTargetSnapshot): Promise<ProjectCatalogFile>;
  markTargetFreshness(
    targetId: string,
    freshness: "stale" | "offline" | "unknown",
    observedAt: number,
  ): Promise<ProjectCatalogFile>;
}

export type {
  ProjectCatalogTargetConnection,
  ProjectCatalogTargetFreshness,
  ProjectCatalogTargetSnapshot,
  ProjectCatalogTargetPresentation,
  ProjectRepositoryReference,
  ProjectWorkspaceReference,
};
