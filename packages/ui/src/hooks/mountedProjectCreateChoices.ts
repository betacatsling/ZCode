import { modelBindingRequestSchema } from "@zcode/shared/agent-host";
import type { HarnessCatalogEntry, ModelBindingRequest } from "@zcode/shared/agent-host";
import type { SidebarSnapshot } from "@zcode/shared/project-workspaces";
import type { MountedHierarchyService } from "./useMountedProjectSidebar.js";

export type MountedCreateChoice = {
  harnessId: string;
  label: string;
  binding: ModelBindingRequest;
};

/** Options are workspace/generation facts; the Host, not this UI filter, certifies the Model. */
export async function readMountedCreateChoices(
  workspaces: SidebarSnapshot["workspaces"],
  harnessLists: readonly (readonly HarnessCatalogEntry[])[],
  hierarchy: MountedHierarchyService,
): Promise<ReadonlyMap<string, readonly MountedCreateChoice[]>> {
  const choices = await Promise.all(
    workspaces.map(async (workspace, index) => {
      const result = await hierarchy.listCreateOptions?.(workspace.id).catch(() => undefined);
      const supported = new Set(
        harnessLists[index]!.filter((entry) => entry.availability === "supported").map(
          (entry) => entry.manifest.id,
        ),
      );
      if (
        !result ||
        !Array.isArray(result.options) ||
        result.workspaceId !== workspace.id ||
        result.worktreeGeneration !== workspace.worktreeGeneration
      )
        return [workspace.id, [] as MountedCreateChoice[]] as const;
      return [
        workspace.id,
        result.options.flatMap((option) => {
          if (!supported.has(option.harnessId)) return [];
          const binding = modelBindingRequestSchema.safeParse(option.binding);
          return binding.success ? [{ ...option, binding: binding.data }] : [];
        }),
      ] as const;
    }),
  );
  return new Map(choices);
}
