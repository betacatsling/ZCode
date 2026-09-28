import {
  projectCatalogFileSchema,
  projectCatalogProjectSchema,
  type CreateProjectInput,
  type ProjectCatalogFile,
  type ProjectCatalogProject,
} from "../contract.js";
import { projectCatalogFileV1Schema } from "../legacyFileSchema.js";

export function emptyProjectCatalogFile(): ProjectCatalogFile {
  return { schemaVersion: 2, projects: [], targets: [] };
}

export function parseProjectCatalog(value: unknown): ProjectCatalogFile {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    const legacy = projectCatalogFileV1Schema.parse(value);
    return projectCatalogFileSchema.parse({
      schemaVersion: 2,
      projects: legacy.projects.map((project) => ({
        ...project,
        repositoryReferences: [],
        workspaceReferences: project.workspaceIds.map((workspaceId) => ({
          projectId: project.id,
          targetId: null,
          workspaceId,
          repositoryBindingId: null,
          verification: "needsVerification",
          lastVerifiedAt: null,
          targetFreshness: "unknown",
          presentation: null,
        })),
      })),
      targets: [],
    });
  }
  return projectCatalogFileSchema.parse(value);
}

export function createProjectRecord(input: CreateProjectInput): ProjectCatalogProject {
  return projectCatalogProjectSchema.parse({
    schemaVersion: 1,
    id: input.id,
    name: input.name,
    ...(input.iconAssetId === undefined ? {} : { iconAssetId: input.iconAssetId }),
    ...(input.defaultWorkspaceId === undefined
      ? {}
      : { defaultWorkspaceId: input.defaultWorkspaceId }),
    workspaceIds: [...(input.workspaceIds ?? [])],
    repositoryReferences: [],
    workspaceReferences: [...(input.workspaceIds ?? [])].map((workspaceId) => ({
      projectId: input.id,
      targetId: null,
      workspaceId,
      repositoryBindingId: null,
      verification: "needsVerification" as const,
      lastVerifiedAt: null,
      targetFreshness: "unknown" as const,
      presentation: null,
    })),
    pinned: input.pinned ?? false,
    sortOrder: input.sortOrder ?? 0,
  });
}

export function sameProjectRecord(
  left: ProjectCatalogProject,
  right: ProjectCatalogProject,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
