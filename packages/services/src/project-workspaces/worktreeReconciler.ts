import type { GitWorktreeFact } from "./adapters/gitWorktreeBackend.js";
import {
  sameFile,
  type FileIdentity,
  type RepositoryInspection,
} from "./repositoryBindingResolver.js";

export interface TargetWorkspaceRecord {
  id: string;
  bindingId: string;
  path: string;
  generation: string;
  adminIdentity: FileIdentity;
  instanceMarker: string;
  kind: GitWorktreeFact["kind"];
  branch: string | null;
  head: string | null;
  lifecycle: "active" | "needsVerification" | "pendingRemoval" | "removed";
}

/** Only matching Git admin-directory identity is proof of a moved worktree; paths/branches are not. */
export async function reconcileWorkspace(
  record: TargetWorkspaceRecord,
  inspected: RepositoryInspection,
  markerMatches: (adminPath: string, marker: string) => Promise<boolean>,
): Promise<TargetWorkspaceRecord> {
  if (record.lifecycle === "removed") return record;
  let match: (typeof inspected.candidates)[number] | undefined;
  for (const candidate of inspected.candidates) {
    if (
      candidate.adminIdentity &&
      candidate.adminPath &&
      sameFile(candidate.adminIdentity, record.adminIdentity) &&
      (await markerMatches(candidate.adminPath, record.instanceMarker))
    ) {
      match = candidate;
      break;
    }
  }
  if (record.lifecycle === "pendingRemoval")
    return { ...record, lifecycle: match ? "needsVerification" : "removed" };
  return match
    ? {
        ...record,
        path: match.path,
        kind: match.kind,
        branch: match.branch,
        head: match.head,
        lifecycle: "active",
      }
    : { ...record, lifecycle: "needsVerification" };
}
