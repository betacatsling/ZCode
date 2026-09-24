import type { HarnessCapabilitiesV2, SessionSpecV2 } from "@zcode/shared/agent-host";

/** Navigation proof issued by the authoritative target-scoped hierarchy, not inferred from a path. */
export interface MountedSessionScope {
  readonly targetId: string;
  readonly workspaceId: string;
  readonly workspaceIdentity: string;
  readonly workspacePath: string;
  readonly remoteSessionId?: string;
}

export type MountedSessionOwner =
  | { readonly kind: "native"; readonly scope: MountedSessionScope; readonly originalSessionId: string }
  | {
      readonly kind: "external";
      readonly scope: MountedSessionScope;
      readonly spec: SessionSpecV2;
      readonly historyOnly: boolean;
    };

/** Optional capabilities are authoritative Host facts; the UI never infers them from method presence. */
export interface MountedExternalSession {
  readonly owner: Extract<MountedSessionOwner, { kind: "external" }>;
  readonly capabilities: HarnessCapabilitiesV2;
}

/** Scope validation is required before any native/Host subscription or command. */
export function matchesMountedSessionOwner(
  owner: MountedSessionOwner,
  sessionId: string,
  scope: { workspacePath: string; workspaceIdentity?: string; remoteSessionId?: string | null },
): boolean {
  const key = scope.workspaceIdentity?.trim() || scope.workspacePath;
  if (
    owner.scope.workspaceIdentity !== key ||
    owner.scope.workspacePath !== scope.workspacePath ||
    (owner.scope.remoteSessionId ?? null) !== (scope.remoteSessionId ?? null)
  ) return false;
  if (owner.kind === "native") return owner.originalSessionId === sessionId;
  return (
    owner.spec.hostSessionId === sessionId &&
    owner.spec.workspaceId === owner.scope.workspaceId &&
    owner.spec.execution.targetId === owner.scope.targetId &&
    owner.spec.execution.workspaceIdentity === owner.scope.workspaceIdentity &&
    owner.spec.execution.worktreePath === owner.scope.workspacePath
  );
}
