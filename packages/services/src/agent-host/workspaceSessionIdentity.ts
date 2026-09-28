import { createHash } from "node:crypto";
import type { WorkspaceSessionCreateRequest } from "@zcode/shared/agent-host";

export function workspaceSessionRequestFingerprint(
  targetId: string,
  request: WorkspaceSessionCreateRequest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetId,
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        worktreeGeneration: request.worktreeGeneration,
        harnessId: request.harnessId,
        modelBinding: request.modelBinding,
        title: request.title ?? null,
      }),
    )
    .digest("hex");
}

export function externalWorkspaceSessionId(targetId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([targetId, requestId]))
    .digest("hex");
  return `workspace-session-${digest.slice(0, 48)}`;
}
