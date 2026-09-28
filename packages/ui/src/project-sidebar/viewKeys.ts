export function projectSidebarWorkspaceViewKey(
  targetId: string | null,
  workspaceId: string,
): string {
  return JSON.stringify([targetId, workspaceId]);
}

export function projectSidebarSessionViewKey(
  targetId: string | null,
  workspaceId: string,
  sessionId: string,
): string {
  return JSON.stringify([targetId, workspaceId, sessionId]);
}
