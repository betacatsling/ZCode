import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "./descriptors.js";
import type { IProjectCatalogService as ProjectCatalogService } from "./project-catalog/contract.js";
import type { IWorktreeService as WorktreeService } from "./worktree/contract.js";
import type { ISessionHierarchyService as SessionHierarchyService } from "./session-hierarchy/contract.js";

/** Browser-safe descriptors; Node factories stay behind @zcode/services/node. */
export type IProjectCatalogService = ProjectCatalogService;
export const IProjectCatalogService = createServiceDescriptor<ProjectCatalogService>(
  ServiceChannels.ProjectCatalog,
);

export type IWorktreeService = WorktreeService;
export const IWorktreeService = createServiceDescriptor<WorktreeService>(ServiceChannels.Worktree);

export type ISessionHierarchyService = SessionHierarchyService;
export const ISessionHierarchyService = createServiceDescriptor<SessionHierarchyService>(
  ServiceChannels.SessionHierarchy,
);

export function getProjectWorkspaceWriteExclusions(
  clientMode: "desktop-continuous" | "web-remote-replayable",
): ReadonlySet<string> {
  return clientMode === "desktop-continuous"
    ? new Set()
    : new Set([
        IProjectCatalogService.channelName,
        IWorktreeService.channelName,
        ISessionHierarchyService.channelName,
      ]);
}
