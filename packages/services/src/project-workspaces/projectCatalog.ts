import { createServiceLogger } from "../logger/serviceLogger.js";
import type { Project } from "./planTypes.js";
import type { CatalogStore } from "./ports.js";
import { ProjectWorkspaceError } from "./errors.js";
import type { CatalogSnapshot } from "./snapshot.js";

const logger = createServiceLogger("project-workspaces");

export interface ProjectCatalog {
  listProjects(): Promise<Project[]>;
  readProject(id: string): Promise<{ project: Project; removedFromApp: boolean } | null>;
  createProject(input: { name: string; iconAssetId?: string; id?: string }): Promise<Project>;
  renameProject(id: string, name: string): Promise<Project>;
  setIcon(id: string, iconAssetId?: string): Promise<Project>;
  setDefaultWorkspace(id: string, workspaceId?: string): Promise<Project>;
  removeFromApp(id: string): Promise<Project>;
}

function visibleProjects(snapshot: CatalogSnapshot): Project[] {
  const removed = new Set(snapshot.removedProjectIds);
  return snapshot.projects.filter((project) => !removed.has(project.id));
}

function requireProject(snapshot: CatalogSnapshot, id: string): Project {
  const project = snapshot.projects.find((item) => item.id === id);
  if (!project) throw new ProjectWorkspaceError("unknown-project");
  return project;
}

function projectFields(
  project: Project,
  patch: { name?: string; iconAssetId?: string | null; defaultWorkspaceId?: string | null },
): Project {
  const next: Project = { id: project.id, name: patch.name ?? project.name };
  const icon = patch.iconAssetId === undefined ? project.iconAssetId : patch.iconAssetId;
  if (icon) next.iconAssetId = icon;
  const defaultWorkspaceId =
    patch.defaultWorkspaceId === undefined ? project.defaultWorkspaceId : patch.defaultWorkspaceId;
  if (defaultWorkspaceId) next.defaultWorkspaceId = defaultWorkspaceId;
  return next;
}

function replaceProject(snapshot: CatalogSnapshot, project: Project): CatalogSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((item) => (item.id === project.id ? project : item)),
  };
}

export function createProjectCatalog(deps: { store: CatalogStore; idFactory: () => string }): ProjectCatalog {
  return {
    async listProjects() {
      return visibleProjects(await deps.store.read());
    },
    async readProject(id) {
      const snapshot = await deps.store.read();
      const project = snapshot.projects.find((item) => item.id === id);
      if (!project) return null;
      return { project, removedFromApp: snapshot.removedProjectIds.includes(id) };
    },
    async createProject(input) {
      const name = input.name?.trim();
      if (!name) throw new ProjectWorkspaceError("invalid-project");
      const project = await deps.store.update((snapshot) => {
        const created = projectFields(
          { id: input.id ?? deps.idFactory(), name },
          { iconAssetId: input.iconAssetId },
        );
        if (snapshot.projects.some((item) => item.id === created.id)) {
          throw new ProjectWorkspaceError("duplicate-project");
        }
        return { snapshot: { ...snapshot, projects: [...snapshot.projects, created] }, result: created };
      });
      logger.info(undefined, "project-created", { projectId: project.id });
      return project;
    },
    async renameProject(id, name) {
      const trimmed = name.trim();
      if (!trimmed) throw new ProjectWorkspaceError("invalid-project");
      return deps.store.update((snapshot) => {
        const project = projectFields(requireProject(snapshot, id), { name: trimmed });
        return { snapshot: replaceProject(snapshot, project), result: project };
      });
    },
    async setIcon(id, iconAssetId) {
      return deps.store.update((snapshot) => {
        const project = projectFields(requireProject(snapshot, id), {
          iconAssetId: iconAssetId?.trim() || null,
        });
        return { snapshot: replaceProject(snapshot, project), result: project };
      });
    },
    async setDefaultWorkspace(id, workspaceId) {
      return deps.store.update((snapshot) => {
        if (workspaceId) {
          const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
          if (!workspace || workspace.projectId !== id) {
            throw new ProjectWorkspaceError("invalid-default-workspace");
          }
        }
        const project = projectFields(requireProject(snapshot, id), {
          defaultWorkspaceId: workspaceId ?? null,
        });
        return { snapshot: replaceProject(snapshot, project), result: project };
      });
    },
    async removeFromApp(id) {
      const project = await deps.store.update((snapshot) => {
        const current = requireProject(snapshot, id);
        const removedProjectIds = snapshot.removedProjectIds.includes(id)
          ? snapshot.removedProjectIds
          : [...snapshot.removedProjectIds, id];
        return { snapshot: { ...snapshot, removedProjectIds }, result: current };
      });
      logger.info(undefined, "project-removed-from-app", { projectId: id });
      return project;
    },
  };
}
