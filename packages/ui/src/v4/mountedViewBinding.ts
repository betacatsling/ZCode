import type { SessionOwner } from "@zcode/services";

/** Local view bookmark, not a cached owner or an admission/command receipt. */
export interface MountedViewBinding {
  kind: "native" | "external";
  targetId: string;
  workspaceId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId?: string;
  worktreeGeneration?: string;
}
const PREFIX = "zcode-mounted-view:v1:";

export function readMountedViewBinding(workspaceKey: string): MountedViewBinding | null {
  try {
    const raw = localStorage.getItem(PREFIX + workspaceKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (
      !["kind", "targetId", "workspaceId", "sessionId", "workspacePath", "workspaceIdentity"].every(
        (key) => typeof record[key] === "string" && Boolean((record[key] as string).trim()),
      ) ||
      (record.kind !== "native" && record.kind !== "external") ||
      (record.kind === "external" &&
        (typeof record.worktreeGeneration !== "string" || !record.worktreeGeneration)) ||
      (record.remoteSessionId !== undefined && typeof record.remoteSessionId !== "string")
    )
      return null;
    return record as unknown as MountedViewBinding;
  } catch {
    return null;
  }
}

export function persistMountedViewBinding(workspaceKey: string, owner: SessionOwner | null): void {
  try {
    if (!owner) {
      localStorage.removeItem(PREFIX + workspaceKey);
      return;
    }
    const { scope } = owner;
    const binding: MountedViewBinding = {
      kind: owner.kind,
      targetId: scope.targetId,
      workspaceId: scope.workspaceId,
      sessionId: owner.kind === "native" ? owner.originalSessionId : owner.spec.hostSessionId,
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
      ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
      ...(owner.kind === "external"
        ? { worktreeGeneration: owner.spec.execution.worktreeGeneration }
        : {}),
    };
    localStorage.setItem(PREFIX + workspaceKey, JSON.stringify(binding));
  } catch {
    // Storage is optional. Never turn a failed bookmark into a session command.
  }
}

export function matchesMountedViewBinding(
  owner: SessionOwner,
  binding: MountedViewBinding,
): boolean {
  return (
    owner.kind === binding.kind &&
    (owner.kind === "native"
      ? owner.originalSessionId === binding.sessionId
      : owner.spec.hostSessionId === binding.sessionId &&
        owner.spec.execution.worktreeGeneration === binding.worktreeGeneration) &&
    owner.scope.targetId === binding.targetId &&
    owner.scope.workspaceId === binding.workspaceId &&
    owner.scope.workspaceIdentity === binding.workspaceIdentity &&
    owner.scope.workspacePath === binding.workspacePath &&
    (owner.scope.remoteSessionId ?? null) === (binding.remoteSessionId ?? null)
  );
}
