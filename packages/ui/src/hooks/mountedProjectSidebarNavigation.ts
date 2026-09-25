import type { SessionSummary, SidebarSnapshot } from "@zcode/shared/project-workspaces";
import type { MountedHierarchyService, MountedSessionOwner } from "./useMountedProjectSidebar.js";

/** Never turn an unknown catalog alias into a native task ID. */
export async function resolveMountedSidebarOwner(
  summary: SessionSummary,
  snapshot: SidebarSnapshot | undefined,
  hierarchy: MountedHierarchyService,
): Promise<MountedSessionOwner> {
  const workspace = snapshot?.workspaces.find((item) => item.id === summary.session.workspaceId);
  const binding = snapshot?.bindings.find((item) => item.id === workspace?.repositoryBindingId);
  if (!workspace || !binding) throw new Error("Unknown workspace owner");
  const owner = await hierarchy.resolveOwner({
    targetId: binding.executionTargetId,
    workspaceId: workspace.id,
    sessionId: summary.session.id,
  });
  if (
    !owner ||
    owner.scope.workspaceId !== workspace.id ||
    owner.scope.targetId !== binding.executionTargetId ||
    (owner.kind === "external" &&
      (owner.spec.hostSessionId !== summary.session.id ||
        owner.spec.workspaceId !== workspace.id ||
        owner.spec.execution.targetId !== binding.executionTargetId))
  )
    throw new Error("Unknown or mismatched session owner");
  return owner;
}
