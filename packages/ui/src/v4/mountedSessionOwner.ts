import { writableSessionSpecV2Schema, type HarnessCapabilitiesV2 } from "@zcode/shared/agent-host";
import type { SessionOwner, WorkspaceNavigationScope } from "@zcode/services";

/** The single authority is the public hierarchy service, not a renderer-side copy. */
export type MountedSessionScope = WorkspaceNavigationScope;
export type MountedSessionOwner = SessionOwner;

/** A local pane binding is a view preference, not an execution grant. */
export function mountedSessionReadOnly(
  routing: "native" | "scoped",
  sessionId: string | null,
  owner: MountedSessionOwner | undefined,
  bindingReadOnly: boolean,
): boolean {
  // 原因：分屏/恢复的本地绑定不包含权威 historyOnly；旧绑定或未解析的 scoped ID
  // 不能在 pane 挂载前短暂恢复可写。以当前 hierarchy owner 的只读事实为准。
  return (
    bindingReadOnly ||
    (routing === "scoped" && Boolean(sessionId) && !owner) ||
    Boolean(owner?.historyOnly)
  );
}

/** Optional capabilities are authoritative Host facts; the UI never infers them from method presence. */
export interface MountedExternalSession {
  readonly owner: Extract<MountedSessionOwner, { kind: "external" }>;
  readonly capabilities: HarnessCapabilitiesV2;
}

/** Scope validation is required before any native/Host subscription or command. */
export function sameMountedExternalOwner(
  a: Extract<MountedSessionOwner, { kind: "external" }>,
  b: Extract<MountedSessionOwner, { kind: "external" }>,
): boolean {
  const aSpec = writableSessionSpecV2Schema.safeParse(a.spec);
  const bSpec = writableSessionSpecV2Schema.safeParse(b.spec);
  return (
    aSpec.success &&
    bSpec.success &&
    a.historyOnly === b.historyOnly &&
    a.scope.targetId === b.scope.targetId &&
    a.scope.workspaceId === b.scope.workspaceId &&
    a.scope.workspaceIdentity === b.scope.workspaceIdentity &&
    a.scope.workspacePath === b.scope.workspacePath &&
    (a.scope.remoteSessionId ?? null) === (b.scope.remoteSessionId ?? null) &&
    JSON.stringify(aSpec.data) === JSON.stringify(bSpec.data)
  );
}

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
  )
    return false;
  if (owner.kind === "native") return owner.originalSessionId === sessionId;
  return (
    owner.spec.hostSessionId === sessionId &&
    owner.spec.workspaceId === owner.scope.workspaceId &&
    owner.spec.execution.targetId === owner.scope.targetId &&
    owner.spec.execution.workspaceIdentity === owner.scope.workspaceIdentity &&
    owner.spec.execution.worktreePath === owner.scope.workspacePath
  );
}
