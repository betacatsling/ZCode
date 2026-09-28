import { createHash } from "node:crypto";

/** Stable native owner ID used only for an explicit, host-stamped workspace creation request. */
export function managedNativeWorkspaceSessionId(targetId: string, requestId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([targetId, requestId]))
    .digest("hex");
  return `sess_managed_workspace_${digest.slice(0, 48)}`;
}
